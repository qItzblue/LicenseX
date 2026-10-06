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

export function createCore(db) {
  const q = {
    setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    putSetting: db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    licenseByKey: db.prepare('SELECT * FROM licenses WHERE key = ?'),
    licenseById: db.prepare('SELECT * FROM licenses WHERE id = ?'),
    licenseByNonce: db.prepare('SELECT * FROM licenses WHERE nonce = ?'),
    group: db.prepare('SELECT * FROM license_groups WHERE id = ?'),
    serversOf: db.prepare("SELECT * FROM servers WHERE license_id = ? AND status != 'removed' ORDER BY first_seen"),
    server: db.prepare('SELECT * FROM servers WHERE license_id = ? AND instance_id = ?'),
    audit: db.prepare('INSERT INTO audit(at,actor,action,target,detail) VALUES(?,?,?,?,?)'),
  };

  const defaults = { default_limit: '1', claims_enabled: '1', public_removal: '1', heartbeat_minutes: '1' };
  const getSetting = k => q.setting.get(k)?.value ?? defaults[k];
  const setSetting = (k, v) => q.putSetting.run(k, String(v));

  const log = (actor, action, target = '', detail = '') => q.audit.run(now(), actor, action, String(target), String(detail));

  /** license override > group limit > global default. -1 = unlimited. */
  function effectiveLimit(lic) {
    if (lic.max_servers != null) return lic.max_servers;
    if (lic.group_id != null) {
      const g = q.group.get(lic.group_id);
      if (g) return g.max_servers;
    }
    return Number(getSetting('default_limit'));
  }

  // Disabled servers keep occupying a slot so an owner can't dodge an admin ban by removing them.
  const usedSlots = lic => q.serversOf.all(lic.id).length;
  const licenseState = lic =>
    lic.status === 'blocked' ? 'blocked'
    : lic.expires_at && lic.expires_at < now() ? 'expired' : 'active';

  function createLicense({ owner = '', note = '', group_id = null, max_servers = null, expires_at = null,
                          source = 'admin', product = '', nonce = null, issued_ip = '', issued_device = '' }) {
    for (let i = 0; i < 5; i++) {
      const key = generateKey();
      try {
        const r = db.prepare(`INSERT INTO licenses(key,owner,note,group_id,max_servers,expires_at,source,product,nonce,issued_ip,issued_device,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(key, owner, note, group_id, max_servers, expires_at, source, product, nonce, issued_ip, issued_device, now());
        return q.licenseById.get(r.lastInsertRowid);
      } catch (e) { if (!/UNIQUE.*licenses\.key/.test(e.message)) throw e; }
    }
    throw new Error('could not generate unique key');
  }

  /**
   * Download-time issuing. Every download carries a unique nonce (BuiltByBit's %%__NONCE__%%),
   * so every download gets its own license - even from the same IP/device - and re-claiming
   * with the same nonce always returns the same license, so a license never changes.
   */
  function claim({ nonce, user = '', product = '', group_id = null, ip, device }) {
    if (getSetting('claims_enabled') !== '1') return { ok: false, code: 'CLAIMS_DISABLED', message: 'License issuing is currently disabled.' };
    nonce = String(nonce || '').slice(0, 128);
    if (!nonce) return { ok: false, code: 'BAD_REQUEST', message: 'Missing nonce.' };
    let lic = q.licenseByNonce.get(nonce);
    let created = false;
    if (!lic) {
      lic = createLicense({ owner: String(user).slice(0, 64), source: 'claim', product: String(product).slice(0, 64),
        group_id, nonce, issued_ip: ip, issued_device: device });
      log('system', 'license.claim', lic.key, `ip=${ip} user=${user} product=${product}`);
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
    if (state === 'blocked') return { ok: false, code: 'LICENSE_BLOCKED', message: lic.block_reason || 'This license has been blocked.' };
    if (state === 'expired') return { ok: false, code: 'LICENSE_EXPIRED', message: 'This license has expired.' };

    const limit = effectiveLimit(lic);
    const base = { heartbeat_minutes: Number(getSetting('heartbeat_minutes')) };
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
      log('system', 'server.register', lic.key, `${ip}:${port} ${name}`);
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
      key: lic.key, owner: lic.owner, state: licenseState(lic), block_reason: lic.status === 'blocked' ? lic.block_reason : '',
      group: g ? { name: g.name, color: g.color } : null, expires_at: lic.expires_at, created_at: lic.created_at,
      limit: effectiveLimit(lic), used: usedSlots(lic),
      servers: q.serversOf.all(lic.id).map(s => ({
        id: s.id, name: s.name, ip: maskIp(s.ip), port: s.port, version: s.version, status: s.status,
        first_seen: s.first_seen, last_seen: s.last_seen,
      })),
    };
  }

  function ownerRemove(lic, serverId) {
    if (getSetting('public_removal') !== '1') return { ok: false, code: 'DISABLED', message: 'Self-service removal is disabled.' };
    const s = db.prepare('SELECT * FROM servers WHERE id = ? AND license_id = ?').get(serverId, lic.id);
    if (!s || s.status === 'removed') return { ok: false, code: 'NOT_FOUND', message: 'Server not found.' };
    if (s.status === 'disabled') return { ok: false, code: 'SERVER_DISABLED', message: 'This server was disabled by an administrator and cannot be removed.' };
    // Soft-remove: kept as 'removed' until the running plugin sees it on its next heartbeat and shuts down.
    db.prepare("UPDATE servers SET status='removed' WHERE id=?").run(s.id);
    log('owner', 'server.remove', lic.key, `${s.ip}:${s.port} ${s.name}`);
    return { ok: true };
  }

  return { q, getSetting, setSetting, log, effectiveLimit, usedSlots, licenseState, createLicense, claim, validate, portalView, ownerRemove };
}

export function maskIp(ip) {
  if (!ip) return '';
  if (ip.includes('.')) return ip.replace(/\.\d+$/, '.x');
  return ip.split(':').slice(0, 4).join(':') + ':…';
}
