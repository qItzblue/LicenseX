// Selling LicenseX plans on BuiltByBit.
//
// The owner lists the paid plans (one monthly, one one-time) as resources on BuiltByBit. Each resource contains a small file
// with the "External license key" placeholder pointing at the owner's LicenseX and carrying the PLAN-SALES SECRET. Everybody who
// buys (or renews) and downloads it gets an access key. The buyer pastes it into their dashboard (Billing -> Activate a key) and
// the plan is switched on for their workspace.
//
//  - Access keys live in their own table (plan_keys). They are not licenses: nothing a team member can name, edit, list, search or
//    delete in the owner's workspace can create or reveal one, and a key opens no plugin or portal.
//  - Keys are issued only for the plan-sales secret, which only the site owner can read or regenerate (it is not the workspace's
//    ordinary BuiltByBit secret, which staff with settings access can see).
//  - A key is used at most once, by one workspace. Revoking an unused key (a refund) stops it. A used key stays on record even if the
//    workspace is deleted, so it can never be used again.
//  - A one-time plan never ends. A monthly plan runs for 31 days per key (a yearly one for 366); keys of a repeating plan carry the
//    month/year in their identity, so a buyer who renews and downloads again gets a fresh key.
//  - Nothing here talks to BuiltByBit: it only answers BuiltByBit's own request for a key and the buyer's activation.
import { randomBytes } from 'node:crypto';
import { HOUSE, KEY_RE, normalizeKey, generateKey, hash, now } from './core.js';

const DAY = 86400;
export const PERIOD_DAYS = { month: 31, year: 366 };

export class RedeemError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

/** The paid plan that BuiltByBit resource `rid` hands out keys for, if any. */
export const planForResource = (db, rid) => (rid ? db.prepare("SELECT * FROM plans WHERE bbb_resource_id = ? AND key != 'free'").get(String(rid)) : null) || null;

/** "2026-10" for a monthly plan, "2026" for a yearly one, "" for one-time plans: keeps each period's key separate. */
export function periodTag(interval, date = new Date()) {
  if (interval === 'month') return date.toISOString().slice(0, 7);
  if (interval === 'year') return date.toISOString().slice(0, 4);
  return '';
}

const SECRET_SETTING = 'plan_sales_secret';
/** The secret that BuiltByBit's placeholder sends for plan resources (created on first use). */
export function planSalesSecret(db, { regenerate = false } = {}) {
  let s = regenerate ? null : db.prepare('SELECT value FROM settings WHERE key = ?').get(SECRET_SETTING)?.value;
  if (!s) {
    s = randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SECRET_SETTING, s);
  }
  return s;
}

/** The key for this BuiltByBit buyer, plan and period: the same one every time, a new one for a new period. */
export function issuePlanKey({ db, plan, user, ip = '', date = new Date() }) {
  const period = periodTag(plan.interval, date);
  const identity = hash(['plankey', plan.key, plan.bbb_resource_id, user, period].join('\0'));
  const have = db.prepare('SELECT key FROM plan_keys WHERE identity = ?').get(identity);
  if (have) return have.key;
  for (let i = 0; i < 5; i++) {
    const key = generateKey();
    try {
      db.prepare('INSERT INTO plan_keys (key, identity, plan_key, resource_id, bbb_user, period, issued_ip, issued_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(key, identity, plan.key, plan.bbb_resource_id, String(user), period, ip, now());
      return key;
    } catch (e) { if (!/UNIQUE.*plan_keys\.key/.test(e.message)) throw e; }
  }
  throw new Error('could not generate a unique key');
}

/** Checks a key without using it: the key row and the plan it is for, or a RedeemError saying why not. */
export function lookupKey({ db, key }) {
  const k = normalizeKey(key);
  const refuse = () => new RedeemError(404, 'That is not a valid access key. Copy it again from the file you downloaded on BuiltByBit.', 'BAD_KEY');
  if (!KEY_RE.test(k)) throw refuse();
  const row = db.prepare('SELECT * FROM plan_keys WHERE key = ?').get(k);
  const plan = row ? db.prepare("SELECT * FROM plans WHERE key = ? AND key != 'free'").get(row.plan_key) : null;
  if (!plan) throw refuse();
  if (row.redeemed_at) throw new RedeemError(409, 'This key has already been used.', 'KEY_USED');
  if (row.status !== 'active') throw new RedeemError(403, 'This key has been cancelled (for example after a refund), so it cannot be used.', 'KEY_REVOKED');
  return { row, plan };
}

/**
 * Switches `workspace`'s plan on with an access key. Throws RedeemError (the key is only used up on success).
 * Returns { plan, until } (until = null: never ends).
 */
export function redeemKey({ db, core, workspace, key }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const { row, plan } = lookupKey({ db, key });   // looked up inside the transaction: two tabs cannot both use one key
    const w = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspace.id);
    const t = now(), entitled = core.entitledPlanKey(w, t), current = entitled === 'free' ? null : db.prepare('SELECT * FROM plans WHERE key = ?').get(entitled);
    // a plan with no end date (one-time, or granted by hand without one) cannot be improved by a key that would only add time
    if (current && !w.plan_until && (plan.interval !== 'once' || current.key === plan.key))
      throw new RedeemError(409, `You already have the ${current.name} plan with no end date, so this key was not used. Keep it for another account.`, 'ALREADY_PERMANENT');
    let until = null;
    if (plan.interval !== 'once') {
      // renewing the same plan adds time on top of what is left; anything else starts now
      const base = current && current.key === plan.key && w.plan_until && w.plan_until > t ? w.plan_until : t;
      until = base + (PERIOD_DAYS[plan.interval] || 31) * DAY;
    }
    db.prepare("UPDATE workspaces SET plan_key = ?, plan_status = 'active', plan_until = ?, plan_source = 'manual', plan_note = ? WHERE id = ?")
      .run(plan.key, until, `BuiltByBit key #${row.id}`, w.id);
    const used = db.prepare('UPDATE plan_keys SET redeemed_by = ?, redeemed_at = ?, period_end = ? WHERE id = ? AND redeemed_at IS NULL').run(w.id, t, until, row.id);
    if (used.changes !== 1) throw new RedeemError(409, 'This key has already been used.', 'KEY_USED');
    db.exec('COMMIT');
    core.log('user', 'plan.redeem', plan.key, `access key #${row.id}${until ? ' until ' + new Date(until * 1000).toISOString().slice(0, 10) : ' (no end date)'}`, w.id);
    return { plan, until };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}

/** The owner's side: the secret for the BuiltByBit placeholder, the keys that were handed out, and revoking one. Site owner only. */
export function registerPlanSales(app) {
  const { route, db, core, HttpError, publicBase } = app;
  route('GET', '/api/admin/plan-sales', async ctx => {
    const keys = db.prepare(`SELECT k.id, k.key, k.plan_key, k.period, k.bbb_user, k.status, k.issued_at, k.redeemed_at, k.period_end, w.name workspace, w.owner_email
      FROM plan_keys k LEFT JOIN workspaces w ON w.id = k.redeemed_by ORDER BY k.id DESC LIMIT 200`).all();
    return [200, { callback_url: `${publicBase(ctx.req)}/api/v1/builtbybit/license`, secret: planSalesSecret(db), keys }];
  }, { platform: true });
  route('POST', '/api/admin/plan-sales/secret', async ctx => {
    planSalesSecret(db, { regenerate: true });
    core.log(ctx.admin.email || 'admin', 'plan-sales.secret', '', 'new secret', HOUSE);
    return [200, { secret: planSalesSecret(db) }];
  }, { platform: true });
  route('POST', '/api/admin/plan-keys/:id/revoke', async ctx => {
    const row = db.prepare('SELECT * FROM plan_keys WHERE id = ?').get(ctx.params.id);
    if (!row) throw new HttpError(404, 'Not found');
    if (row.redeemed_at) throw new HttpError(409, 'This key was already used. Change the customer\'s plan under Customers instead.');
    db.prepare("UPDATE plan_keys SET status = 'revoked' WHERE id = ?").run(row.id);
    core.log(ctx.admin.email || 'admin', 'plan-key.revoke', row.plan_key, `access key #${row.id}`, HOUSE);
    return [200, { ok: true }];
  }, { platform: true });
}
