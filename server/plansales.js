// Selling LicenseX plans on BuiltByBit.
//
// The owner lists the paid plans (one monthly, one one-time) as resources on BuiltByBit. Each resource contains a small file
// with the "External license key" placeholder pointing at the owner's own LicenseX. Everybody who buys (or renews) and
// downloads it gets an access key, issued as a license in the owner's workspace. The buyer pastes that key into their
// dashboard (Billing -> Activate a key), and the plan is switched on for their workspace.
//
//  - A key can be used once, by one workspace. Blocking the license (a refund) stops an unused key from working.
//  - A one-time plan never ends. A monthly plan runs for 31 days per key (a yearly one for 366); keys of a repeating plan
//    carry the month/year in their identity, so a buyer who renews and downloads again gets a fresh key.
//  - Nothing here talks to BuiltByBit: it only ever answers BuiltByBit's own request for a key and the buyer's activation.
import { HOUSE, KEY_RE, normalizeKey, now } from './core.js';

const DAY = 86400;
export const PERIOD_DAYS = { month: 31, year: 366 };
const PRODUCT_RE = /^BuiltByBit resource (\d{1,12})(?: (\d{4}(?:-\d{2})?))?$/;

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

/** Checks a key without using it: the license and the plan it is for, or a RedeemError saying why not. */
export function lookupKey({ db, core, key }) {
  const k = normalizeKey(key);
  const refuse = () => new RedeemError(404, 'That is not a valid access key. Copy it again from the file you downloaded on BuiltByBit.', 'BAD_KEY');
  if (!KEY_RE.test(k)) throw refuse();
  const lic = core.q.licenseByKey.get(k);
  const m = lic && lic.workspace_id === HOUSE && lic.source === 'claim' ? PRODUCT_RE.exec(lic.product) : null;
  const plan = m ? planForResource(db, m[1]) : null;
  if (!plan) throw refuse();
  if (lic.status === 'blocked') throw new RedeemError(403, 'This key has been cancelled (for example after a refund), so it cannot be used.', 'KEY_REVOKED');
  if (db.prepare('SELECT 1 FROM plan_redemptions WHERE license_id = ?').get(lic.id)) throw new RedeemError(409, 'This key has already been used.', 'KEY_USED');
  return { lic, plan };
}

/**
 * Switches `workspace`'s plan on with an access key. Throws RedeemError (the key is only used up on success).
 * Returns { plan, until } (until = null: never ends).
 */
export function redeemKey({ db, core, workspace, key }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const { lic, plan } = lookupKey({ db, core, key });   // looked up inside the transaction: two tabs cannot both use one key
    const w = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspace.id);
    const t = now(), entitled = core.entitledPlanKey(w, t), current = entitled === 'free' ? null : db.prepare('SELECT * FROM plans WHERE key = ?').get(entitled);
    let until = null;
    if (plan.interval !== 'once') {
      if (current?.interval === 'once') throw new RedeemError(409, `You already have the ${current.name} plan, which never ends, so this key was not used. Keep it for another account.`, 'ALREADY_LIFETIME');
      // renewing the same plan adds time on top of what is left; anything else starts now
      const base = current && current.key === plan.key && w.plan_until && w.plan_until > t ? w.plan_until : t;
      until = base + (PERIOD_DAYS[plan.interval] || 31) * DAY;
    }
    db.prepare("UPDATE workspaces SET plan_key = ?, plan_status = 'active', plan_until = ?, plan_source = 'manual', plan_note = ? WHERE id = ?")
      .run(plan.key, until, `BuiltByBit key ${lic.key}`, w.id);
    db.prepare('INSERT INTO plan_redemptions (license_id, workspace_id, plan_key, redeemed_at, period_end) VALUES (?,?,?,?,?)').run(lic.id, w.id, plan.key, t, until);
    db.exec('COMMIT');
    core.log('user', 'plan.redeem', plan.key, `key ${lic.key}${until ? ' until ' + new Date(until * 1000).toISOString().slice(0, 10) : ' (no end date)'}`, w.id);
    return { plan, until };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}
