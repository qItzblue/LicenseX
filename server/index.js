import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, createReadStream, createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { openDb } from './db.js';
import { createCore, normalizeKey, KEY_RE, hash, now } from './core.js';
import { injectFiles } from './jarstamp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT || 3000);
const DATA = process.env.LICENSEX_DATA || join(ROOT, 'data');
const PRODUCTS_DIR = join(DATA, 'products');
const PUBLIC_URL = (process.env.LICENSEX_PUBLIC_URL || '').replace(/\/+$/, '');
const MAX_UPLOAD = Number(process.env.LICENSEX_MAX_UPLOAD_MB || 64) * 1024 * 1024;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

mkdirSync(DATA, { recursive: true });
mkdirSync(PRODUCTS_DIR, { recursive: true });
const db = openDb(process.env.LICENSEX_DB || join(DATA, 'licensex.db'));
const core = createCore(db);

// --- secrets -------------------------------------------------------------
function loadSecret(name, make) {
  const f = join(DATA, name);
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  const v = make();
  writeFileSync(f, v, { mode: 0o600 });
  return v;
}
const SESSION_SECRET = loadSecret('session.secret', () => randomBytes(32).toString('hex'));
let ADMIN_PASSWORD = process.env.LICENSEX_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = loadSecret('admin-password.txt', () => randomBytes(9).toString('base64url'));
  console.log(`[LicenseX] No LICENSEX_ADMIN_PASSWORD set. Generated admin password stored in ${join(DATA, 'admin-password.txt')}`);
}

const sign = v => createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const makeSession = () => { const exp = String(Date.now() + 12 * 3600e3); return `${exp}.${sign(exp)}`; };
const validSession = tok => { const [exp, sig] = String(tok || '').split('.'); return !!sig && safeEq(sig, sign(exp)) && Number(exp) > Date.now(); };

// --- tiny helpers --------------------------------------------------------
const clientIp = req => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress?.replace(/^::ffff:/, '') || '';
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const buckets = new Map();
function rateLimit(id, max, windowMs) {
  const t = Date.now(), b = (buckets.get(id) || []).filter(x => t - x < windowMs);
  b.push(t); buckets.set(id, b);
  return b.length <= max;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of buckets) if (!v.some(x => t - x < 3600e3)) buckets.delete(k); }, 600e3).unref();

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const json = (res, status, body, headers = {}) => {
  const text = typeof body === 'string'; // plain-text responses (BuiltByBit expects the bare key)
  res.writeHead(status, { 'Content-Type': text ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text ? body : JSON.stringify(body));
};
async function body(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 32768) throw new HttpError(413, 'Body too large'); chunks.push(c); }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString();
  if (/x-www-form-urlencoded/i.test(req.headers['content-type'] || '')) return Object.fromEntries(new URLSearchParams(text)); // BuiltByBit posts a form
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
const int = (v, { min = -1, max = 1e6, nullable = false } = {}) => {
  if (v === null || v === '' || v === undefined) { if (nullable) return null; throw new HttpError(400, 'Number required'); }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Number must be an integer between ${min} and ${max}`);
  return n;
};
const str = (v, max = 200) => String(v ?? '').slice(0, max);
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'product';

/** Stream a request body straight to disk with a hard size cap. Used for plugin uploads. */
async function saveUpload(req, destPath) {
  const tmp = destPath + '.tmp-' + randomBytes(4).toString('hex');
  const out = createWriteStream(tmp);
  let size = 0;
  try {
    for await (const c of req) {
      size += c.length;
      if (size > MAX_UPLOAD) throw new HttpError(413, `File too large (max ${Math.round(MAX_UPLOAD / 1048576)} MB)`);
      if (!out.write(c)) await new Promise(r => out.once('drain', r));
    }
    await new Promise((res, rej) => out.end(err => err ? rej(err) : res()));
  } catch (e) { out.destroy(); try { rmSync(tmp, { force: true }); } catch {} throw e; }
  if (size === 0) { try { rmSync(tmp, { force: true }); } catch {} throw new HttpError(400, 'Empty upload'); }
  renameSync(tmp, destPath);
  return size;
}

// --- routes --------------------------------------------------------------
const routes = []; // [method, regex, handler, {admin}]
const route = (method, path, handler, opts = {}) =>
  routes.push([method, new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, opts]);

// Plugin API ----------------------------------------------------------------
route('POST', '/api/v1/claim', async ctx => {
  if (!rateLimit('claim:' + ctx.ip, 20, 60e3)) throw new HttpError(429, 'Too many requests');
  const b = await body(ctx.req);
  const r = core.claim({ nonce: b.nonce, user: b.user, name: b.name, product: b.product, ip: ctx.ip, device: b.device ? hash(b.device) : hash(ctx.ip + ctx.req.headers['user-agent']) });
  return [r.ok ? 200 : 403, r];
});
route('POST', '/api/v1/validate', async ctx => {
  if (!rateLimit('val:' + ctx.ip, 600, 60e3)) throw new HttpError(429, 'Too many requests');
  const b = await body(ctx.req);
  const r = core.validate({ key: b.key, instanceId: b.instanceId, name: b.name, port: b.port, version: b.version, ip: ctx.ip });
  return [r.ok ? 200 : 403, r];
});

// BuiltByBit "External license key" placeholder --------------------------------
// BuiltByBit POSTs {user_id, resource_id, version_id, secret, ...} (form-encoded) every time a buyer downloads
// and writes the plain-text response over %%__BBB_LICENSE__%% inside the file. user_id is the buyer, so the same
// buyer always gets the same license no matter how often they download.
const bbbSecret = () => {
  let s = core.getSetting('bbb_secret');
  if (!s) { s = randomBytes(24).toString('base64url'); core.setSetting('bbb_secret', s); }
  return s;
};
route('POST', '/api/v1/builtbybit/license', async ctx => {
  if (!rateLimit('bbb:' + ctx.ip, 300, 60e3)) throw new HttpError(429, 'Too many requests');
  const b = await body(ctx.req);
  if (!safeEq(hash(b.secret ?? ''), hash(bbbSecret()))) { core.log('system', 'bbb.denied', ctx.ip, 'bad secret'); return [403, 'Forbidden'] }
  const uid = str(b.user_id, 32).trim(), rid = str(b.resource_id, 32).trim();
  if (!/^\d+$/.test(uid)) return [400, 'Missing user_id'];
  const gid = Number(core.getSetting('bbb_group_id')) || null;
  const r = core.claim({ user: uid, name: `BuiltByBit #${uid}`, product: `BuiltByBit resource ${rid || '?'}`,
    group_id: gid && db.prepare('SELECT 1 FROM license_groups WHERE id=?').get(gid) ? gid : null, ip: ctx.ip, device: hash('bbb') });
  if (!r.ok) return [503, r.message];
  return [200, r.key];
});

// Public site info (branding + links shown on the home page; never secrets) -----
const SITE_KEYS = ['site_name', 'site_tagline', 'discord_url', 'store_url', 'website_url', 'support_email'];
route('GET', '/api/public/site', async () => [200, Object.fromEntries(SITE_KEYS.map(k => [k, core.getSetting(k)]))]);

// Public portal ---------------------------------------------------------------
async function portalLicense(ctx) {
  if (!rateLimit('portal:' + ctx.ip, 40, 60e3)) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
  const b = await body(ctx.req);
  const key = normalizeKey(b.key);
  const lic = KEY_RE.test(key) ? core.q.licenseByKey.get(key) : null;
  if (!lic) throw new HttpError(404, 'License not found. Check the key and try again.');
  return { lic, b };
}
route('POST', '/api/public/lookup', async ctx => {
  const { lic } = await portalLicense(ctx);
  return [200, { ...core.portalView(lic), public_removal: core.getSetting('public_removal') === '1' }];
});
route('POST', '/api/public/remove', async ctx => {
  const { lic, b } = await portalLicense(ctx);
  const r = core.ownerRemove(lic, int(b.serverId, { min: 1 }));
  if (!r.ok) throw new HttpError(409, r.message, r.code);
  return [200, { ...core.portalView(lic), public_removal: true }];
});

// Admin auth ------------------------------------------------------------------
route('POST', '/api/admin/login', async ctx => {
  if (!rateLimit('login:' + ctx.ip, 8, 5 * 60e3)) throw new HttpError(429, 'Too many login attempts');
  const b = await body(ctx.req);
  if (!safeEq(hash(b.password ?? ''), hash(ADMIN_PASSWORD))) { core.log('admin', 'login.fail', ctx.ip); throw new HttpError(401, 'Wrong password'); }
  core.log('admin', 'login', ctx.ip);
  return [200, { ok: true }, { 'Set-Cookie': `lx_admin=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` }];
});
route('POST', '/api/admin/logout', async () => [200, { ok: true }, { 'Set-Cookie': 'lx_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }]);
route('GET', '/api/admin/me', async () => [200, { ok: true }], { admin: true });

// Admin: stats ----------------------------------------------------------------
route('GET', '/api/admin/stats', async () => {
  const one = sql => db.prepare(sql).get();
  const t = now();
  return [200, {
    licenses: one('SELECT COUNT(*) n FROM licenses').n,
    blocked: one("SELECT COUNT(*) n FROM licenses WHERE status='blocked'").n,
    servers: one("SELECT COUNT(*) n FROM servers WHERE status='active'").n,
    online: one(`SELECT COUNT(*) n FROM servers WHERE status='active' AND last_seen > ${t - 2 * Number(core.getSetting('heartbeat_minutes')) * 60}`).n,
    disabled: one("SELECT COUNT(*) n FROM servers WHERE status='disabled'").n,
    issued_24h: one(`SELECT COUNT(*) n FROM licenses WHERE created_at > ${t - 86400}`).n,
    recent: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 8').all(),
    per_day: db.prepare(`SELECT date(created_at,'unixepoch') d, COUNT(*) n FROM licenses WHERE created_at > ? GROUP BY d ORDER BY d`).all(t - 14 * 86400),
  }];
}, { admin: true });

// Admin: licenses -------------------------------------------------------------
const licenseRow = l => ({ ...l, state: core.licenseState(l), limit: core.effectiveLimit(l), used: core.usedSlots(l) });
route('GET', '/api/admin/licenses', async ctx => {
  const u = ctx.url.searchParams, where = [], args = [];
  const text = u.get('q')?.trim();
  if (text) { where.push('(key LIKE ? OR owner LIKE ? OR note LIKE ? OR issued_ip LIKE ? OR issued_device LIKE ?)'); args.push(...Array(5).fill(`%${text}%`)); }
  if (u.get('status') === 'blocked') where.push("status='blocked'");
  if (u.get('status') === 'active') where.push("status='active'");
  if (u.get('group')) { where.push('group_id = ?'); args.push(Number(u.get('group'))); }
  if (u.get('ip')) { where.push('issued_ip = ?'); args.push(u.get('ip')); }
  const rows = db.prepare(`SELECT * FROM licenses ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`).all(...args);
  return [200, rows.map(licenseRow)];
}, { admin: true });
route('GET', '/api/admin/licenses/:id', async ctx => {
  const lic = core.q.licenseById.get(ctx.params.id);
  if (!lic) throw new HttpError(404, 'Not found');
  const same_ip = db.prepare('SELECT id,key,owner,created_at FROM licenses WHERE issued_ip = ? AND id != ? AND issued_ip != \'\' ORDER BY id DESC LIMIT 20').all(lic.issued_ip, lic.id);
  return [200, { ...licenseRow(lic), servers: db.prepare('SELECT * FROM servers WHERE license_id = ? ORDER BY first_seen').all(lic.id), same_ip }];
}, { admin: true });

function licenseFields(b, partial) {
  const f = {};
  if (!partial || 'owner' in b) f.owner = str(b.owner, 64);
  if (!partial || 'note' in b) f.note = str(b.note, 500);
  if (!partial || 'group_id' in b) {
    f.group_id = int(b.group_id, { min: 1, nullable: true });
    if (f.group_id != null && !db.prepare('SELECT 1 FROM license_groups WHERE id=?').get(f.group_id)) throw new HttpError(400, 'Unknown group');
  }
  if (!partial || 'max_servers' in b) f.max_servers = int(b.max_servers, { min: -1, max: 100000, nullable: true });
  if (!partial || 'expires_at' in b) f.expires_at = int(b.expires_at, { min: 1, max: 4e10, nullable: true });
  if ('status' in b) { if (!['active', 'blocked'].includes(b.status)) throw new HttpError(400, 'Bad status'); f.status = b.status; }
  if ('block_reason' in b) f.block_reason = str(b.block_reason, 200);
  return f;
}
route('POST', '/api/admin/licenses', async ctx => {
  const b = await body(ctx.req);
  const lic = core.createLicense(licenseFields(b, false));
  core.log('admin', 'license.create', lic.key, lic.owner);
  return [201, licenseRow(lic)];
}, { admin: true });
route('PATCH', '/api/admin/licenses/:id', async ctx => {
  const lic = core.q.licenseById.get(ctx.params.id);
  if (!lic) throw new HttpError(404, 'Not found');
  const f = licenseFields(await body(ctx.req), true);
  if (f.status === 'active') f.block_reason = '';
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE licenses SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => f[k]), lic.id);
  core.log('admin', f.status ? (f.status === 'blocked' ? 'license.block' : 'license.unblock') : 'license.update', lic.key, JSON.stringify(f));
  return [200, licenseRow(core.q.licenseById.get(lic.id))];
}, { admin: true });
route('DELETE', '/api/admin/licenses/:id', async ctx => {
  const lic = core.q.licenseById.get(ctx.params.id);
  if (!lic) throw new HttpError(404, 'Not found');
  db.prepare('DELETE FROM licenses WHERE id=?').run(lic.id);
  core.log('admin', 'license.delete', lic.key, lic.owner);
  return [200, { ok: true }];
}, { admin: true });

// Admin: servers --------------------------------------------------------------
route('GET', '/api/admin/servers', async ctx => {
  const text = ctx.url.searchParams.get('q')?.trim();
  const rows = db.prepare(`SELECT s.*, l.key license_key, l.owner FROM servers s JOIN licenses l ON l.id = s.license_id
    WHERE s.status != 'removed' ${text ? 'AND (s.name LIKE ?1 OR s.ip LIKE ?1 OR l.key LIKE ?1 OR l.owner LIKE ?1)' : ''} ORDER BY s.last_seen DESC LIMIT 500`).all(...(text ? [`%${text}%`] : []));
  return [200, rows];
}, { admin: true });
route('PATCH', '/api/admin/servers/:id', async ctx => {
  const b = await body(ctx.req);
  if (!['active', 'disabled'].includes(b.status)) throw new HttpError(400, 'Bad status');
  const s = db.prepare('SELECT s.*, l.key k FROM servers s JOIN licenses l ON l.id=s.license_id WHERE s.id=?').get(ctx.params.id);
  if (!s) throw new HttpError(404, 'Not found');
  db.prepare('UPDATE servers SET status=? WHERE id=?').run(b.status, s.id);
  core.log('admin', b.status === 'disabled' ? 'server.disable' : 'server.enable', s.k, `${s.ip}:${s.port} ${s.name}`);
  return [200, { ok: true }];
}, { admin: true });
route('DELETE', '/api/admin/servers/:id', async ctx => {
  const s = db.prepare('SELECT s.*, l.key k FROM servers s JOIN licenses l ON l.id=s.license_id WHERE s.id=?').get(ctx.params.id);
  if (!s) throw new HttpError(404, 'Not found');
  db.prepare("UPDATE servers SET status='removed' WHERE id=?").run(s.id); // plugin learns about it on next heartbeat
  core.log('admin', 'server.remove', s.k, `${s.ip}:${s.port} ${s.name}`);
  return [200, { ok: true }];
}, { admin: true });

// Admin: products (plugin downloads) ------------------------------------------
const productFile = slug => join(PRODUCTS_DIR, slug + '.bin');
const downloadUrlFor = (req, p) => {
  const origin = PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost:' + PORT}`;
  return `${origin}/download/${p.slug}?token=${p.token}`;
};
const productRow = (req, p) => ({ ...p, download_url: downloadUrlFor(req, p) });
route('GET', '/api/admin/products', async ctx => {
  const rows = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  return [200, rows.map(p => productRow(ctx.req, p))];
}, { admin: true });
route('POST', '/api/admin/products', async ctx => {
  const b = await body(ctx.req);
  const name = str(b.name, 60).trim();
  if (!name) throw new HttpError(400, 'Name required');
  const group_id = b.group_id ? int(b.group_id, { min: 1 }) : null;
  if (group_id != null && !db.prepare('SELECT 1 FROM license_groups WHERE id=?').get(group_id)) throw new HttpError(400, 'Unknown group');
  let slug = slugify(b.slug || name), base = slug, i = 2;
  while (db.prepare('SELECT 1 FROM products WHERE slug=?').get(slug)) slug = `${base}-${i++}`;
  const r = db.prepare('INSERT INTO products(slug,name,token,group_id,created_at) VALUES(?,?,?,?,?)').run(slug, name, randomBytes(12).toString('base64url'), group_id, now());
  core.log('admin', 'product.create', slug, name);
  return [201, productRow(ctx.req, db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid))];
}, { admin: true });
// Raw binary upload (the plugin jar). Streamed to disk, not parsed as JSON.
route('POST', '/api/admin/products/:id/file', async ctx => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(ctx.params.id);
  if (!p) throw new HttpError(404, 'Not found');
  const filename = str(ctx.req.headers['x-filename'] || 'plugin.jar', 80);
  const size = await saveUpload(ctx.req, productFile(p.slug));
  // Reject anything that isn't a readable zip/jar, so download-time stamping can't fail later.
  try { injectFiles(readFileSync(productFile(p.slug)), [{ name: '.licensex-probe', content: '1' }]); }
  catch { rmSync(productFile(p.slug), { force: true }); throw new HttpError(400, 'That file is not a valid .jar/.zip archive.'); }
  db.prepare('UPDATE products SET filename=?, size=?, has_file=1 WHERE id=?').run(filename, size, p.id);
  core.log('admin', 'product.upload', p.slug, `${filename} ${size}B`);
  return [200, productRow(ctx.req, db.prepare('SELECT * FROM products WHERE id=?').get(p.id))];
}, { admin: true });
route('PATCH', '/api/admin/products/:id', async ctx => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(ctx.params.id);
  if (!p) throw new HttpError(404, 'Not found');
  const b = await body(ctx.req), f = {};
  if ('name' in b) { f.name = str(b.name, 60).trim(); if (!f.name) throw new HttpError(400, 'Name required'); }
  if ('enabled' in b) f.enabled = b.enabled ? 1 : 0;
  if ('group_id' in b) { f.group_id = b.group_id ? int(b.group_id, { min: 1 }) : null; if (f.group_id != null && !db.prepare('SELECT 1 FROM license_groups WHERE id=?').get(f.group_id)) throw new HttpError(400, 'Unknown group'); }
  if (b.regenerate_token) f.token = randomBytes(12).toString('base64url');
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE products SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => f[k]), p.id);
  core.log('admin', 'product.update', p.slug, JSON.stringify(f).replace(/"token":"[^"]+"/, '"token":"***"'));
  return [200, productRow(ctx.req, db.prepare('SELECT * FROM products WHERE id=?').get(p.id))];
}, { admin: true });
route('DELETE', '/api/admin/products/:id', async ctx => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(ctx.params.id);
  if (!p) throw new HttpError(404, 'Not found');
  rmSync(productFile(p.slug), { force: true });
  db.prepare('DELETE FROM products WHERE id=?').run(p.id);
  core.log('admin', 'product.delete', p.slug, p.name);
  return [200, { ok: true }];
}, { admin: true });

// Admin: groups ---------------------------------------------------------------
const groupFields = b => {
  const name = str(b.name, 40).trim();
  if (!name) throw new HttpError(400, 'Name required');
  const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#8b5cf6';
  return [name, int(b.max_servers, { min: -1, max: 100000 }), color];
};
route('GET', '/api/admin/groups', async () => [200, db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM licenses WHERE group_id=g.id) licenses FROM license_groups g ORDER BY g.id`).all()], { admin: true });
route('POST', '/api/admin/groups', async ctx => {
  const [name, max, color] = groupFields(await body(ctx.req));
  try { db.prepare('INSERT INTO license_groups(name,max_servers,color,created_at) VALUES(?,?,?,?)').run(name, max, color, now()); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A group with that name exists'); throw e; }
  core.log('admin', 'group.create', name, `limit=${max}`);
  return [201, { ok: true }];
}, { admin: true });
route('PATCH', '/api/admin/groups/:id', async ctx => {
  const [name, max, color] = groupFields(await body(ctx.req));
  try { db.prepare('UPDATE license_groups SET name=?, max_servers=?, color=? WHERE id=?').run(name, max, color, ctx.params.id); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A group with that name exists'); throw e; }
  core.log('admin', 'group.update', name, `limit=${max}`);
  return [200, { ok: true }];
}, { admin: true });
route('DELETE', '/api/admin/groups/:id', async ctx => {
  db.prepare('DELETE FROM license_groups WHERE id=?').run(ctx.params.id);
  core.log('admin', 'group.delete', ctx.params.id);
  return [200, { ok: true }];
}, { admin: true });

// Admin: settings + audit -----------------------------------------------------
route('GET', '/api/admin/settings', async ctx => [200, {
  ...Object.fromEntries(['default_limit', 'claims_enabled', 'public_removal', 'heartbeat_minutes', 'bbb_group_id', ...SITE_KEYS].map(k => [k, core.getSetting(k)])),
  bbb_secret: bbbSecret(),
  bbb_callback_url: `${PUBLIC_URL || `${ctx.req.headers['x-forwarded-proto'] || 'http'}://${ctx.req.headers.host}`}/api/v1/builtbybit/license`,
}], { admin: true });
const httpUrl = (v, label) => {
  v = String(v ?? '').trim().slice(0, 300);
  if (!v) return '';
  let u; try { u = new URL(v); } catch { throw new HttpError(400, `${label} must be a full link, e.g. https://discord.gg/yourinvite`); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, `${label} must start with http:// or https://`);
  return u.href;
};
route('PUT', '/api/admin/settings', async ctx => {
  const b = await body(ctx.req);
  if ('default_limit' in b) core.setSetting('default_limit', int(b.default_limit, { min: -1, max: 100000 }));
  if ('heartbeat_minutes' in b) core.setSetting('heartbeat_minutes', int(b.heartbeat_minutes, { min: 1, max: 1440 }));
  for (const k of ['claims_enabled', 'public_removal']) if (k in b) core.setSetting(k, b[k] ? '1' : '0');
  if ('site_name' in b) core.setSetting('site_name', str(b.site_name, 40).trim() || 'LicenseX');
  if ('site_tagline' in b) core.setSetting('site_tagline', str(b.site_tagline, 140).trim());
  if ('discord_url' in b) core.setSetting('discord_url', httpUrl(b.discord_url, 'Discord link'));
  if ('store_url' in b) core.setSetting('store_url', httpUrl(b.store_url, 'BuiltByBit link'));
  if ('website_url' in b) core.setSetting('website_url', httpUrl(b.website_url, 'Website link'));
  if ('support_email' in b) {
    const e = str(b.support_email, 120).trim();
    if (e && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e)) throw new HttpError(400, 'Support email is not a valid address');
    core.setSetting('support_email', e);
  }
  if ('bbb_group_id' in b) {
    const g = b.bbb_group_id ? int(b.bbb_group_id, { min: 1 }) : '';
    if (g && !db.prepare('SELECT 1 FROM license_groups WHERE id=?').get(g)) throw new HttpError(400, 'Unknown group');
    core.setSetting('bbb_group_id', g);
  }
  if (b.regenerate_bbb_secret) core.setSetting('bbb_secret', randomBytes(24).toString('base64url'));
  core.log('admin', 'settings.update', '', JSON.stringify({ ...b, bbb_secret: undefined }));
  return [200, { ok: true }];
}, { admin: true });
route('GET', '/api/admin/audit', async ctx => [200, db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(Number(ctx.url.searchParams.get('limit')) || 100, 500))], { admin: true });

// --- public download (BuiltByBit points here) ------------------------------
// GET /download/:slug?token=...&nonce=...&user=...
// Issues a license for the nonce (new per nonce, stable on repeat), stamps the key into the jar and serves it.
function handleDownload(req, res, slug, url) {
  const ip = clientIp(req);
  if (!rateLimit('dl:' + ip, 60, 60e3)) throw new HttpError(429, 'Too many downloads. Try again shortly.');
  const p = db.prepare('SELECT * FROM products WHERE slug=?').get(slug);
  if (!p || !p.has_file || !p.enabled) throw new HttpError(404, 'This download is not available.');
  if (!safeEq(url.searchParams.get('token') || '', p.token)) throw new HttpError(403, 'Invalid or missing download token.');

  // A known buyer (?user=) always gets the same license. With no buyer id and no (real) nonce - e.g. someone
  // opening the raw link - there is nothing to match on, so that download gets a fresh license.
  const nonce = str(url.searchParams.get('nonce'), 128).trim();
  const r = core.claim({ nonce: nonce.includes('%%') || !nonce ? 'anon-' + randomBytes(12).toString('hex') : nonce,
    user: str(url.searchParams.get('user'), 64), name: str(url.searchParams.get('name'), 64), product: p.name, group_id: p.group_id, ip, device: hash(ip + req.headers['user-agent']) });
  if (!r.ok) throw new HttpError(403, r.message, r.code);

  const stamped = injectFiles(readFileSync(productFile(p.slug)), [{ name: 'licensex.json',
    content: JSON.stringify({ url: PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`, key: r.key, product: p.name, issued: now() }) }]);
  db.prepare('UPDATE products SET downloads = downloads + 1 WHERE id=?').run(p.id);
  core.log('system', 'product.download', p.slug, `${r.key} ip=${ip}`);

  const dlName = (p.filename && /\.(jar|zip)$/i.test(p.filename) ? p.filename : slugify(p.name) + '.jar');
  res.writeHead(200, { 'Content-Type': 'application/java-archive', 'Content-Length': stamped.length,
    'Content-Disposition': `attachment; filename="${dlName.replace(/[^\w.\-]/g, '_')}"`, 'Cache-Control': 'no-store' });
  res.end(stamped);
}

// --- static + dispatch -----------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = resolve(WEB, '.' + pathname);
  const rel = relative(WEB, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { ok: false, message: 'Not found' });
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'");
  try {
    const dl = url.pathname.match(/^\/download\/([a-z0-9-]{1,48})$/);
    if (dl) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return handleDownload(req, res, dl[1], url);
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, decodeURIComponent(url.pathname));
    }
    for (const [method, re, handler, opts] of routes) {
      const m = req.method === method && re.exec(url.pathname);
      if (!m) continue;
      if (opts.admin && !validSession(cookies(req).lx_admin)) throw new HttpError(401, 'Not signed in');
      const [status, payload, headers] = await handler({ req, url, params: m.groups || {}, ip: clientIp(req) });
      return json(res, status, payload, headers);
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { ok: false, code: e.code, message: e.message });
    console.error(e);
    json(res, 500, { ok: false, message: 'Internal error' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.on('error', e => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`[LicenseX] Port ${PORT} is already in use (probably an old LicenseX still running). Close it or start on another port, e.g. PORT=3001 npm start (PowerShell: $env:PORT=3001; npm start).`);
    process.exit(1);
  });
  server.listen(PORT, () => console.log(`[LicenseX] listening on http://localhost:${PORT}  (admin: /admin)`));
}
