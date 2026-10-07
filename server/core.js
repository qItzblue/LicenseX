// Business logic. Pure functions over the db handle, no HTTP in here.
import { randomBytes, createHash } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const now = () => Math.floor(Date.now() / 1000);

export function generateKey() {
  const bytes = randomBytes(16);
  const chars = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]);
  return 'LX-' + [0, 4, 8, 12].map(i => chars.slice(i, i + 4).join('')).join('-');
}
export const normalizeKey = k => String(k || '').trim().toUpperCase();
export const KEY_RE = /^LX-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/;
export const hash = s => createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

/** Thrown when a workspace tries to create more than its plan allows. */
export class PlanError extends Error {
  constructor(message) { super(message); this.code = 'PLAN_LIMIT'; }
}
export const HOUSE = 1;                 // the owner's own workspace: never limited by a plan
const GRACE = 3 * 86400;                // slack after a paid period ends, so a late renewal webhook doesn't cut anyone off
const WS_KEYS = new Set(['default_limit', 'claims_enabled', 'public_removal', 'heartbeat_minutes', 'bbb_group_id']);

export function createCore(db) {
  const q = {
    wsSetting: db.prepare('SELECT value FROM ws_settings WHERE workspace_id = ? AND key = ?'),
    putWsSetting: db.prepare('INSERT INTO ws_settings(workspace_id,key,value) VALUES(?,?,?) ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value'),
    workspace: db.prepare('SELECT * FROM workspaces WHERE id = ?'),
    plan: db.prepare('SELECT * FROM plans WHERE key = ?'),
    countLicenses: db.prepare('SELECT COUNT(*) n FROM licenses WHERE workspace_id = ?'),
    countProducts: db.prepare('SELECT COUNT(*) n FROM products WHERE workspace_id = ?'),
    setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    putSetting: db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    licenseByKey: db.prepare('SELECT * FROM licenses WHERE key = ?'),
    licenseById: db.prepare('SELECT * FROM licenses WHERE id = ?'),
    licenseByNonce: db.prepare('SELECT * FROM licenses WHERE nonce = ?'),
    group: db.prepare('SELECT * FROM license_groups WHERE id = ?'),
    serversOf: db.prepare("SELECT * FROM servers WHERE license_id = ? AND status != 'removed' ORDER BY first_seen"),
    server: db.prepare('SELECT * FROM servers WHERE license_id = ? AND instance_id = ?'),
    audit: db.prepare('INSERT INTO audit(workspace_id,at,actor,action,target,detail) VALUES(?,?,?,?,?,?)'),
  };

  const defaults = { default_limit: '1', claims_enabled: '1', public_removal: '1', heartbeat_minutes: '1',
    admin_emails: '', site_name: 'LicenseX', site_tagline: '', discord_url: '', store_url: '', website_url: '', support_email: '', bbb_group_id: '' };
  // Settings that shape a customer's licenses (limits, heartbeat, ...) are per workspace; branding and admin lists are global.
  const getSetting = (k, ws = HOUSE) => (WS_KEYS.has(k) ? q.wsSetting.get(ws, k) : q.setting.get(k))?.value ?? defaults[k];
  const setSetting = (k, v, ws = HOUSE) => (WS_KEYS.has(k) ? q.putWsSetting.run(ws, k, String(v)) : q.putSetting.run(k, String(v)));

  const log = (actor, action, target = '', detail = '', ws = HOUSE) => q.audit.run(ws, now(), actor, action, String(target), String(detail));

  // --- plans ---------------------------------------------------------------------------------
  /**
   * The plan a workspace is entitled to RIGHT NOW. A paid plan counts while its period (plus a short grace) lasts, also
   * after cancelling. Lapsing only stops new licenses/products: existing licenses keep working, because a customer's
   * failed card must never switch their buyers' servers off.
   */
  function entitledPlanKey(w, t = now()) {
    if (w.plan_key === 'free') return 'free';
    const ok = w.plan_until ? t <= w.plan_until + GRACE : w.plan_status !== 'canceled';
    return ok ? w.plan_key : 'free';
  }
  function planOf(wsId) {
    const w = q.workspace.get(wsId);
    if (!w) return null;
    if (wsId === HOUSE) return { key: 'owner', name: 'Owner', max_products: -1, max_licenses: -1, interval: 'free', price_cents: 0 };
    return q.plan.get(entitledPlanKey(w)) || q.plan.get('free') || { key: 'free', name: 'Free', max_products: 1, max_licenses: 25, interval: 'free', price_cents: 0 };
  }
  const usage = wsId => ({ licenses: q.countLicenses.get(wsId).n, products: q.countProducts.get(wsId).n });
  /** Throws PlanError when adding one more `kind` ('licenses' | 'products') would exceed the plan. */
  function assertWithin(wsId, kind) {
    const plan = planOf(wsId);
    if (!plan) throw new PlanError('Unknown workspace.');
    const max = plan[kind === 'licenses' ? 'max_licenses' : 'max_products'];
    if (max !== -1 && usage(wsId)[kind] >= max)
      throw new PlanError(`The ${plan.name} plan allows up to ${max.toLocaleString('en-US')} ${kind === 'licenses' ? 'licenses' : max === 1 ? 'plugin' : 'plugins'}. Upgrade the plan to add more.`);
  }
  const isSuspended = wsId => !!q.workspace.get(wsId)?.suspended;

  /** license override > group limit > global default. -1 = unlimited. */
  function effectiveLimit(lic) {
    if (lic.max_servers != null) return lic.max_servers;
    if (lic.group_id != null) {
      const g = q.group.get(lic.group_id);
      if (g) return g.max_servers;
    }
    return Number(getSetting('default_limit', lic.workspace_id));
  }

  // Disabled servers keep occupying a slot so an owner can't dodge an admin ban by removing them.
  const usedSlots = lic => q.serversOf.all(lic.id).length;
  const licenseState = lic =>
    lic.status === 'blocked' || isSuspended(lic.workspace_id) ? 'blocked'
    : lic.expires_at && lic.expires_at < now() ? 'expired' : 'active';
  const blockReason = lic => (lic.status === 'blocked' ? lic.block_reason : isSuspended(lic.workspace_id) ? (q.workspace.get(lic.workspace_id).suspended_reason || 'This developer\'s account is suspended.') : '');

  function createLicense({ workspace_id = HOUSE, owner = '', note = '', group_id = null, max_servers = null, expires_at = null,
                          source = 'admin', product = '', nonce = null, issued_ip = '', issued_device = '' }) {
    assertWithin(workspace_id, 'licenses');
    for (let i = 0; i < 5; i++) {
      const key = generateKey();
      try {
        const r = db.prepare(`INSERT INTO licenses(workspace_id,key,owner,note,group_id,max_servers,expires_at,source,product,nonce,issued_ip,issued_device,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(workspace_id, key, owner, note, group_id, max_servers, expires_at, source, product, nonce, issued_ip, issued_device, now());
        return q.licenseById.get(r.lastInsertRowid);
      } catch (e) { if (!/UNIQUE.*licenses\.key/.test(e.message)) throw e; }
    }
    throw new Error('could not generate unique key');
  }

  /**
   * Download-time issuing. A license belongs to a buyer, not to a download:
   *  - a known buyer (BuiltByBit's %%__USER__%% id) gets ONE license per product, however many times they
   *    download, and different buyers get different licenses even from the same IP/device;
   *  - an unidentified download (no buyer id) can't be matched to anyone, so it gets its own license, stable
   *    per nonce.
   * Values still containing an unreplaced %%__PLACEHOLDER%% count as "not provided", otherwise every
   * such request would share one license.
   */
  const real = v => { v = String(v ?? '').trim(); return v && !v.includes('%%') ? v : ''; };
  function claim({ ws = HOUSE, nonce, user = '', name = '', product = '', group_id = null, ip, device }) {
    if (isSuspended(ws)) return { ok: false, code: 'SUSPENDED', message: 'This developer\'s account is suspended.' };
    if (getSetting('claims_enabled', ws) !== '1') return { ok: false, code: 'CLAIMS_DISABLED', message: 'License issuing is currently disabled.' };
    const uid = real(user).slice(0, 64), label = real(name).slice(0, 64) || uid;
    // Identity is hashed so long ids/product names can't truncate into a collision.
    const identity = uid ? 'user:' + hash(ws + '\0' + String(product) + '\0' + uid) : real(nonce).slice(0, 128);
    if (!identity) return { ok: false, code: 'BAD_REQUEST', message: 'Missing buyer or nonce.' };
    let lic = q.licenseByNonce.get(identity);
    let created = false;
    if (lic && lic.workspace_id !== ws) return { ok: false, code: 'BAD_REQUEST', message: 'Unavailable.' }; // never hand out another workspace's license
    if (!lic) {
      try { lic = createLicense({ workspace_id: ws, owner: label, source: 'claim', product: String(product).slice(0, 64),
        group_id, nonce: identity, issued_ip: ip, issued_device: device }); }
      catch (e) { if (e instanceof PlanError) return { ok: false, code: e.code, message: e.message }; throw e; }
      log('system', 'license.claim', lic.key, `ip=${ip} user=${uid || '-'} product=${product}`, ws);
      created = true;
    }
    return { ok: true, key: lic.key, created, product: lic.product };
  }

  /** Called by the plugin on start and on every heartbeat. */
  function validate({ key, instanceId, name = '', port = null, version = '', ip }) {
    key = normalizeKey(key);
    instanceId = String(instanceId || '').slice(0, 64);
    if (!KEY_RE.test(key) || !instanceId) return { ok: false, code: 'BAD_REQUEST', message: 'Malformed request.' };
    const lic = q.licenseByKey.get(key);
    if (!lic) return { ok: false, code: 'INVALID_KEY', message: 'Unknown license key.' };
    const state = licenseState(lic);
    if (state === 'blocked') return { ok: false, code: 'LICENSE_BLOCKED', message: blockReason(lic) || 'This license has been blocked.' };
    if (state === 'expired') return { ok: false, code: 'LICENSE_EXPIRED', message: 'This license has expired.' };

    const limit = effectiveLimit(lic);
    const base = { heartbeat_minutes: Number(getSetting('heartbeat_minutes', lic.workspace_id)) };
    let srv = q.server.get(lic.id, instanceId);
    if (srv?.status === 'removed') {
      db.prepare('DELETE FROM servers WHERE id = ?').run(srv.id); // acknowledged; next start registers fresh
      return { ok: false, code: 'SERVER_REMOVED', message: 'This server was removed from the license.' };
    }
    if (srv?.status === 'disabled') return { ok: false, code: 'SERVER_DISABLED', message: 'This server has been disabled by an administrator.' };

    if (!srv) {
      if (limit !== -1 && usedSlots(lic) >= limit)
        return { ok: false, code: 'LIMIT_REACHED', message: `Server limit reached (${limit}). Remove a server at the license portal first.` };
      db.prepare('INSERT INTO servers(license_id,instance_id,name,ip,port,version,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?)')
        .run(lic.id, instanceId, String(name).slice(0, 64), ip, Number.isInteger(port) ? port : null, String(version).slice(0, 32), now(), now());
      log('system', 'server.register', lic.key, `${ip}:${port} ${name}`, lic.workspace_id);
    } else {
      db.prepare('UPDATE servers SET last_seen=?, ip=?, port=?, name=?, version=? WHERE id=?')
        .run(now(), ip, Number.isInteger(port) ? port : srv.port, String(name).slice(0, 64), String(version).slice(0, 32), srv.id);
    }
    return { ok: true, ...base, limit, used: usedSlots(lic) };
  }

  /** Owner-facing view for the public website. IPs are masked, the key itself is the credential. */
  function portalView(lic) {
    const g = lic.group_id != null ? q.group.get(lic.group_id) : null;
    return {
      key: lic.key, owner: lic.owner, state: licenseState(lic), block_reason: blockReason(lic),
      group: g ? { name: g.name, color: g.color } : null, expires_at: lic.expires_at, created_at: lic.created_at,
      limit: effectiveLimit(lic), used: usedSlots(lic),
      servers: q.serversOf.all(lic.id).map(s => ({
        id: s.id, name: s.name, ip: maskIp(s.ip), port: s.port, version: s.version, status: s.status,
        first_seen: s.first_seen, last_seen: s.last_seen,
      })),
    };
  }

  function ownerRemove(lic, serverId) {
    if (getSetting('public_removal', lic.workspace_id) !== '1') return { ok: false, code: 'DISABLED', message: 'Self-service removal is disabled.' };
    const s = db.prepare('SELECT * FROM servers WHERE id = ? AND license_id = ?').get(serverId, lic.id);
    if (!s || s.status === 'removed') return { ok: false, code: 'NOT_FOUND', message: 'Server not found.' };
    if (s.status === 'disabled') return { ok: false, code: 'SERVER_DISABLED', message: 'This server was disabled by an administrator and cannot be removed.' };
    // Soft-remove: kept as 'removed' until the running plugin sees it on its next heartbeat and shuts down.
    db.prepare("UPDATE servers SET status='removed' WHERE id=?").run(s.id);
    log('owner', 'server.remove', lic.key, `${s.ip}:${s.port} ${s.name}`, lic.workspace_id);
    return { ok: true };
  }

  return { q, now, HOUSE, getSetting, setSetting, log, planOf, usage, assertWithin, isSuspended, entitledPlanKey, effectiveLimit, usedSlots, licenseState, createLicense, claim, validate, portalView, ownerRemove };
}

export function maskIp(ip) {
  if (!ip) return '';
  if (ip.includes('.')) return ip.replace(/\.\d+$/, '.x');
  return ip.split(':').slice(0, 4).join(':') + ':…';
}
