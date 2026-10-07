import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, createReadStream, createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { openDb, DatabaseSync } from './db.js';
import { createBackup, restoreBackup, RestoreError } from './backup.js';
import { createBuildService, BuildError } from './builder.js';
import { createBilling, verifySignature, StripeError } from './billing.js';
import { providerDefs, authorizeUrl, exchangeCode, fetchProfile, parseEmails, EMAIL_RE } from './auth.js';
import { createCore, normalizeKey, KEY_RE, hash, now, PlanError, HOUSE } from './core.js';
import { injectFiles } from './jarstamp.js';
import { wrapJar, checkWrappable, WrapError } from './wrapjar.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');

// Settings come from environment variables, or from licensex.config.json next to this folder (env vars win).
// The config file exists for hosts that only let you upload files.
const CONFIG_FILE = process.env.LICENSEX_CONFIG || join(ROOT, 'licensex.config.json');
let fileConfig = {};
if (existsSync(CONFIG_FILE)) {
  try { fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { console.error(`[LicenseX] ${CONFIG_FILE} is not valid JSON: ${e.message}`); process.exit(1); }
}
const PORT = Number(process.env.PORT || fileConfig.port || 3000);
const DATA = process.env.LICENSEX_DATA || fileConfig.dataDir || join(ROOT, 'data');
const PRODUCTS_DIR = join(DATA, 'products');
const PUBLIC_URL = String(process.env.LICENSEX_PUBLIC_URL || fileConfig.publicUrl || '').replace(/\/+$/, '');
const MAX_UPLOAD = Number(process.env.LICENSEX_MAX_UPLOAD_MB || fileConfig.maxUploadMb || 64) * 1024 * 1024;
const TRUST_PROXY = (process.env.TRUST_PROXY ?? String(fileConfig.trustProxy ?? '')) === '1' || fileConfig.trustProxy === true;

// "Sign in with ..." (see docs/LOGIN.md). A provider is on when both its client id and secret are set.
const PROVIDERS = providerDefs(process.env.LICENSEX_OAUTH_TEST_BASE);
const oauthConf = {};
for (const p of Object.keys(PROVIDERS)) {
  const id = process.env[`LICENSEX_${p.toUpperCase()}_CLIENT_ID`] || fileConfig.oauth?.[p]?.clientId;
  const secret = process.env[`LICENSEX_${p.toUpperCase()}_CLIENT_SECRET`] || fileConfig.oauth?.[p]?.clientSecret;
  if (id && secret) oauthConf[p] = { clientId: String(id), clientSecret: String(secret) };
}
// Stripe (optional): without a secret key the pricing page just offers "contact us" and plans are granted by hand.
const STRIPE = {
  secretKey: process.env.LICENSEX_STRIPE_SECRET_KEY || fileConfig.stripe?.secretKey || '',
  webhookSecret: process.env.LICENSEX_STRIPE_WEBHOOK_SECRET || fileConfig.stripe?.webhookSecret || '',
  apiBase: process.env.LICENSEX_STRIPE_API_BASE || 'https://api.stripe.com',   // only overridden by the tests
};
if (STRIPE.secretKey && !/^(sk|rk)_(test|live)_/.test(STRIPE.secretKey)) console.error('[LicenseX] The Stripe secret key should start with sk_test_ or sk_live_ (a "restricted" rk_ key also works).');
// Emails that are admins no matter what the database says (so you can never lock yourself out of the settings page).
const CONFIG_ADMIN_EMAILS = parseEmails(process.env.LICENSEX_ADMIN_EMAILS ?? fileConfig.adminEmails ?? '');
const DISABLE_PASSWORD_LOGIN = process.env.LICENSEX_DISABLE_PASSWORD_LOGIN === '1' || fileConfig.disablePasswordLogin === true;
if (DISABLE_PASSWORD_LOGIN && (!Object.keys(oauthConf).length || !CONFIG_ADMIN_EMAILS.length)) {
  console.error('[LicenseX] disablePasswordLogin needs at least one sign-in provider and one admin email in the config, or nobody could log in.');
  process.exit(1);
}

mkdirSync(DATA, { recursive: true });
mkdirSync(PRODUCTS_DIR, { recursive: true });
const db = openDb(process.env.LICENSEX_DB || join(DATA, 'licensex.db'));
const core = createCore(db);

// Products uploaded before integration checks existed (or with an older wrapper) get analysed on startup.
for (const p of db.prepare("SELECT * FROM products WHERE has_file=1 AND wrap_ok=0 AND wrap_code=''").all()) {
  try {
    const w = checkWrappable(readFileSync(join(PRODUCTS_DIR, p.slug + '.bin')));
    db.prepare('UPDATE products SET wrap_ok=?, wrap_code=?, wrap_message=?, main_class=? WHERE id=?').run(w.ok ? 1 : 0, w.code, w.message, w.main || '', p.id);
  } catch (e) { console.error(`[LicenseX] could not analyse product ${p.slug}: ${e.message}`); }
}

// --- secrets -------------------------------------------------------------
function loadSecret(name, make) {
  const f = join(DATA, name);
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  const v = make();
  writeFileSync(f, v, { mode: 0o600 });
  return v;
}
const SESSION_SECRET = loadSecret('session.secret', () => randomBytes(32).toString('hex'));
let ADMIN_PASSWORD = process.env.LICENSEX_ADMIN_PASSWORD || fileConfig.adminPassword;
if (ADMIN_PASSWORD && /^CHANGE-ME/i.test(ADMIN_PASSWORD)) {
  console.error('[LicenseX] Set a real admin password in licensex.config.json (it still says CHANGE-ME...).');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = loadSecret('admin-password.txt', () => randomBytes(9).toString('base64url'));
  console.log(`[LicenseX] No LICENSEX_ADMIN_PASSWORD set. Generated admin password stored in ${join(DATA, 'admin-password.txt')}`);
}

const sign = v => createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
/** Signed, expiring cookie payloads (OAuth state, user sessions). Stateless, so they survive restarts. */
const signToken = obj => { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${p}.${sign(p)}`; };
const readToken = tok => {
  const [p, sig] = String(tok || '').split('.');
  if (!p || !sig || !safeEq(sig, sign(p))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
};
const makeSession = () => { const exp = String(Date.now() + 12 * 3600e3); return `${exp}.${sign(exp)}`; };
const validSession = tok => { const [exp, sig] = String(tok || '').split('.'); return !!sig && safeEq(sig, sign(exp)) && Number(exp) > Date.now(); };

// --- tiny helpers --------------------------------------------------------
const clientIp = req => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress?.replace(/^::ffff:/, '') || '';
const isHttps = req => PUBLIC_URL.startsWith('https://') || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const secure = req => (isHttps(req) ? '; Secure' : '');
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
  if (Buffer.isBuffer(body)) { // binary download (headers carry the content type)
    res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': body.length, ...headers });
    return res.end(body);
  }
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
const newSecret = () => randomBytes(24).toString('base64url');
const bbbSecretOf = wsId => {
  let s = db.prepare('SELECT bbb_secret FROM workspaces WHERE id=?').get(wsId)?.bbb_secret;
  if (!s) { s = newSecret(); db.prepare('UPDATE workspaces SET bbb_secret=? WHERE id=?').run(s, wsId); }
  return s;
};
route('POST', '/api/v1/builtbybit/license', async ctx => {
  if (!rateLimit('bbb:' + ctx.ip, 300, 60e3)) throw new HttpError(429, 'Too many requests');
  const b = await body(ctx.req);
  // the secret identifies the developer (workspace) whose buyer this is
  const secret = typeof b.secret === 'string' ? b.secret : '';
  const w = secret.length >= 16 ? db.prepare('SELECT * FROM workspaces WHERE bbb_secret = ?').get(secret) : null;
  if (!w) { core.log('system', 'bbb.denied', ctx.ip, 'bad secret'); return [403, 'Forbidden']; }
  const uid = str(b.user_id, 32).trim(), rid = str(b.resource_id, 32).trim();
  if (!/^\d+$/.test(uid)) return [400, 'Missing user_id'];
  const gid = Number(core.getSetting('bbb_group_id', w.id)) || null;
  const r = core.claim({ ws: w.id, user: uid, name: `BuiltByBit #${uid}`, product: `BuiltByBit resource ${rid || '?'}`,
    group_id: gid && db.prepare('SELECT 1 FROM license_groups WHERE id=? AND workspace_id=?').get(gid, w.id) ? gid : null, ip: ctx.ip, device: hash('bbb') });
  if (!r.ok) return [r.code === 'PLAN_LIMIT' ? 402 : 503, r.message];
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
  return [200, { ...core.portalView(lic), public_removal: core.getSetting('public_removal', lic.workspace_id) === '1' }];
});
route('POST', '/api/public/remove', async ctx => {
  const { lic, b } = await portalLicense(ctx);
  const r = core.ownerRemove(lic, int(b.serverId, { min: 1 }));
  if (!r.ok) throw new HttpError(409, r.message, r.code);
  return [200, { ...core.portalView(lic), public_removal: true }];
});

// Admin auth ------------------------------------------------------------------
route('POST', '/api/admin/login', async ctx => {
  if (DISABLE_PASSWORD_LOGIN) throw new HttpError(403, 'Password login is turned off. Sign in with Google, Discord or GitHub.');
  if (!rateLimit('login:' + ctx.ip, 8, 5 * 60e3)) throw new HttpError(429, 'Too many login attempts');
  const b = await body(ctx.req);
  if (!safeEq(hash(b.password ?? ''), hash(ADMIN_PASSWORD))) { core.log('admin', 'login.fail', ctx.ip); throw new HttpError(401, 'Wrong password'); }
  core.log('admin', 'login', ctx.ip);
  return [200, { ok: true }, { 'Set-Cookie': `lx_admin=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure(ctx.req)}` }];
});
const CLEAR_COOKIES = ['lx_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'lx_user=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'];
route('POST', '/api/admin/logout', async () => [200, { ok: true }, { 'Set-Cookie': CLEAR_COOKIES }]);
route('GET', '/api/admin/me', async ctx => {
  const w = db.prepare('SELECT id, name, plan_key, suspended FROM workspaces WHERE id=?').get(ctx.wsId);
  return [200, { ok: true, via: ctx.admin.via, role: ctx.admin.role, name: ctx.admin.name, email: ctx.admin.email || '',
    workspace: { id: w.id, name: w.name, house: w.id === HOUSE, suspended: !!w.suspended, plan: core.planOf(w.id) } }];
}, { admin: true });

// Who is signed in with Google/Discord/GitHub, and are they an admin? (public: the site header uses it)
const adminEmailSet = () => new Set([...CONFIG_ADMIN_EMAILS, ...parseEmails(core.getSetting('admin_emails'))]);
const sessionUser = req => readToken(cookies(req).lx_user);
const isAdminUser = u => !!u && Array.isArray(u.emails) && u.emails.some(e => adminEmailSet().has(e)); // checked on every request
const workspaceOfUser = u => {
  if (!u || !Array.isArray(u.emails) || !u.emails.length) return null;
  const marks = u.emails.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM workspaces WHERE owner_email IN (${marks}) ORDER BY id LIMIT 1`).get(...u.emails) || null;
};
/**
 * Who is calling the admin API?
 *  - platform: the owner (admin password, or a verified email on the admin list). Can open any workspace.
 *  - tenant:   a customer whose verified email owns a workspace. Can only ever touch that workspace.
 */
const adminIdentity = req => {
  if (validSession(cookies(req).lx_admin)) return { via: 'password', role: 'platform', name: 'Admin password' };
  const u = sessionUser(req);
  if (!u) return null;
  if (isAdminUser(u)) return { via: u.p, role: 'platform', name: u.name, email: u.email };
  const w = workspaceOfUser(u);
  return w ? { via: u.p, role: 'tenant', name: u.name, email: u.email, wsId: w.id } : null;
};
/** Which workspace a request acts on. Tenants: their own, always. Platform: the one they picked (default: the owner's). */
function resolveWorkspace(admin, req, url) {
  if (admin.role === 'tenant') return admin.wsId;
  const asked = Number(req.headers['x-workspace'] || url.searchParams.get('ws') || HOUSE);
  return Number.isInteger(asked) && db.prepare('SELECT 1 FROM workspaces WHERE id=?').get(asked) ? asked : HOUSE;
}
route('GET', '/api/auth/me', async ctx => {
  const u = sessionUser(ctx.req);
  return [200, {
    user: u ? { name: u.name, email: u.email, avatar: u.avatar, provider: u.p, isAdmin: isAdminUser(u) } : null,
    providers: Object.keys(oauthConf).map(id => ({ id, label: PROVIDERS[id].label })),
    password_login: !DISABLE_PASSWORD_LOGIN,
  }];
});
route('POST', '/api/auth/logout', async () => [200, { ok: true }, { 'Set-Cookie': CLEAR_COOKIES }]);

// OAuth redirect flow: GET /auth/<provider>  ->  provider  ->  GET /auth/<provider>/callback
const NEXT_OK = new Set(['/', '/admin', '/login']);
const redirect = (res, to, cookiesOut = []) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...(cookiesOut.length ? { 'Set-Cookie': cookiesOut } : {}) }); res.end(); };
async function handleAuth(req, res, url) {
  const m = /^\/auth\/(google|discord|github)(\/callback)?$/.exec(url.pathname);
  if (!m || req.method !== 'GET') throw new HttpError(404, 'Not found');
  const [, provider, isCallback] = m, conf = oauthConf[provider], def = PROVIDERS[provider], ip = clientIp(req);
  const fail = code => redirect(res, `/login?error=${code}`, ['lx_oauth=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0']);
  if (!conf) return fail('notconfigured');
  if (!rateLimit('auth:' + ip, 60, 60e3)) throw new HttpError(429, 'Too many sign-in attempts. Try again in a minute.');
  const redirectUri = `${publicBase(req)}/auth/${provider}/callback`;

  if (!isCallback) {
    const state = randomBytes(18).toString('base64url');
    const next = NEXT_OK.has(url.searchParams.get('next')) ? url.searchParams.get('next') : '/';
    const cookie = `lx_oauth=${signToken({ s: state, p: provider, n: next, exp: Date.now() + 10 * 60e3 })}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600${secure(req)}`;
    return redirect(res, authorizeUrl(def, { clientId: conf.clientId, redirectUri, state }), [cookie]);
  }

  const pending = readToken(cookies(req).lx_oauth);
  const state = url.searchParams.get('state') || '';
  if (!pending || pending.p !== provider || !safeEq(pending.s, state)) return fail('state'); // CSRF / expired / replayed
  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code) return fail('failed');
  let profile;
  try { profile = await fetchProfile(provider, def, await exchangeCode(def, { ...conf, redirectUri, code })); }
  catch (e) { core.log('system', 'login.error', provider, e.message); return fail('failed'); }
  if (!profile.id) return fail('failed');

  const user = { p: provider, id: profile.id, name: String(profile.name).slice(0, 80), avatar: String(profile.avatar).slice(0, 300),
    email: profile.email, emails: profile.emails.slice(0, 5), exp: Date.now() + 7 * 86400e3 };
  core.log('user', isAdminUser(user) ? 'login.admin' : 'login', `${provider}:${profile.email || profile.id}`);
  redirect(res, pending.n && NEXT_OK.has(pending.n) ? pending.n : '/', [
    `lx_user=${signToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${secure(req)}`,
    'lx_oauth=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0']);
}

// Admin: stats ----------------------------------------------------------------
route('GET', '/api/admin/stats', async ctx => {
  const w = ctx.wsId, t = now(), one = (sql, ...args) => db.prepare(sql).get(...args);
  const hb = Number(core.getSetting('heartbeat_minutes', w));
  return [200, {
    licenses: one('SELECT COUNT(*) n FROM licenses WHERE workspace_id=?', w).n,
    blocked: one("SELECT COUNT(*) n FROM licenses WHERE workspace_id=? AND status='blocked'", w).n,
    servers: one("SELECT COUNT(*) n FROM servers s JOIN licenses l ON l.id=s.license_id WHERE l.workspace_id=? AND s.status='active'", w).n,
    online: one("SELECT COUNT(*) n FROM servers s JOIN licenses l ON l.id=s.license_id WHERE l.workspace_id=? AND s.status='active' AND s.last_seen > ?", w, t - 2 * hb * 60).n,
    disabled: one("SELECT COUNT(*) n FROM servers s JOIN licenses l ON l.id=s.license_id WHERE l.workspace_id=? AND s.status='disabled'", w).n,
    issued_24h: one('SELECT COUNT(*) n FROM licenses WHERE workspace_id=? AND created_at > ?', w, t - 86400).n,
    recent: db.prepare('SELECT * FROM audit WHERE workspace_id=? ORDER BY id DESC LIMIT 8').all(w),
    per_day: db.prepare(`SELECT date(created_at,'unixepoch') d, COUNT(*) n FROM licenses WHERE workspace_id=? AND created_at > ? GROUP BY d ORDER BY d`).all(w, t - 14 * 86400),
  }];
}, { admin: true });

// Admin: licenses -------------------------------------------------------------
// Everything below is scoped to ctx.wsId (the caller's own workspace). Looking a row up by id ALWAYS includes the workspace.
const ownLicense = (ctx, id) => { const l = db.prepare('SELECT * FROM licenses WHERE id=? AND workspace_id=?').get(id, ctx.wsId); if (!l) throw new HttpError(404, 'Not found'); return l; };
const ownProduct = (ctx, id) => { const p = db.prepare('SELECT * FROM products WHERE id=? AND workspace_id=?').get(id, ctx.wsId); if (!p) throw new HttpError(404, 'Not found'); return p; };
const ownGroup = (ctx, gid) => { if (gid == null) return null; if (!db.prepare('SELECT 1 FROM license_groups WHERE id=? AND workspace_id=?').get(gid, ctx.wsId)) throw new HttpError(400, 'Unknown group'); return gid; };
const wl = (ctx, action, target = '', detail = '') => core.log('admin', action, target, detail, ctx.wsId);
const withinPlan = fn => { try { return fn(); } catch (e) { if (e instanceof PlanError) throw new HttpError(402, e.message, e.code); throw e; } };
const licenseRow = l => ({ ...l, state: core.licenseState(l), limit: core.effectiveLimit(l), used: core.usedSlots(l) });
route('GET', '/api/admin/licenses', async ctx => {
  const u = ctx.url.searchParams, where = ['workspace_id = ?'], args = [ctx.wsId];
  const text = u.get('q')?.trim();
  if (text) { where.push('(key LIKE ? OR owner LIKE ? OR note LIKE ? OR issued_ip LIKE ? OR issued_device LIKE ?)'); args.push(...Array(5).fill(`%${text}%`)); }
  if (u.get('status') === 'blocked') where.push("status='blocked'");
  if (u.get('status') === 'active') where.push("status='active'");
  if (u.get('group')) { where.push('group_id = ?'); args.push(Number(u.get('group'))); }
  if (u.get('ip')) { where.push('issued_ip = ?'); args.push(u.get('ip')); }
  const rows = db.prepare(`SELECT * FROM licenses WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 500`).all(...args);
  return [200, rows.map(licenseRow)];
}, { admin: true });
route('GET', '/api/admin/licenses/:id', async ctx => {
  const lic = ownLicense(ctx, ctx.params.id);
  const same_ip = db.prepare('SELECT id,key,owner,created_at FROM licenses WHERE workspace_id = ? AND issued_ip = ? AND id != ? AND issued_ip != \'\' ORDER BY id DESC LIMIT 20').all(ctx.wsId, lic.issued_ip, lic.id);
  return [200, { ...licenseRow(lic), servers: db.prepare('SELECT * FROM servers WHERE license_id = ? ORDER BY first_seen').all(lic.id), same_ip }];
}, { admin: true });

function licenseFields(ctx, b, partial) {
  const f = {};
  if (!partial || 'owner' in b) f.owner = str(b.owner, 64);
  if (!partial || 'note' in b) f.note = str(b.note, 500);
  if (!partial || 'group_id' in b) {
    f.group_id = ownGroup(ctx, int(b.group_id, { min: 1, nullable: true }));
  }
  if (!partial || 'max_servers' in b) f.max_servers = int(b.max_servers, { min: -1, max: 100000, nullable: true });
  if (!partial || 'expires_at' in b) f.expires_at = int(b.expires_at, { min: 1, max: 4e10, nullable: true });
  if ('status' in b) { if (!['active', 'blocked'].includes(b.status)) throw new HttpError(400, 'Bad status'); f.status = b.status; }
  if ('block_reason' in b) f.block_reason = str(b.block_reason, 200);
  return f;
}
route('POST', '/api/admin/licenses', async ctx => {
  const b = await body(ctx.req);
  const lic = withinPlan(() => core.createLicense({ ...licenseFields(ctx, b, false), workspace_id: ctx.wsId }));
  wl(ctx, 'license.create', lic.key, lic.owner);
  return [201, licenseRow(lic)];
}, { admin: true });
route('PATCH', '/api/admin/licenses/:id', async ctx => {
  const lic = ownLicense(ctx, ctx.params.id);
  const f = licenseFields(ctx, await body(ctx.req), true);
  if (f.status === 'active') f.block_reason = '';
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE licenses SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => f[k]), lic.id);
  wl(ctx, f.status ? (f.status === 'blocked' ? 'license.block' : 'license.unblock') : 'license.update', lic.key, JSON.stringify(f));
  return [200, licenseRow(core.q.licenseById.get(lic.id))];
}, { admin: true });
route('DELETE', '/api/admin/licenses/:id', async ctx => {
  const lic = ownLicense(ctx, ctx.params.id);
  db.prepare('DELETE FROM licenses WHERE id=?').run(lic.id);
  wl(ctx, 'license.delete', lic.key, lic.owner);
  return [200, { ok: true }];
}, { admin: true });

// Admin: servers --------------------------------------------------------------
route('GET', '/api/admin/servers', async ctx => {
  const text = ctx.url.searchParams.get('q')?.trim();
  const rows = db.prepare(`SELECT s.*, l.key license_key, l.owner FROM servers s JOIN licenses l ON l.id = s.license_id
    WHERE l.workspace_id = ?2 AND s.status != 'removed' ${text ? 'AND (s.name LIKE ?1 OR s.ip LIKE ?1 OR l.key LIKE ?1 OR l.owner LIKE ?1)' : ''} ORDER BY s.last_seen DESC LIMIT 500`).all(text ? `%${text}%` : null, ctx.wsId);
  return [200, rows];
}, { admin: true });
route('PATCH', '/api/admin/servers/:id', async ctx => {
  const b = await body(ctx.req);
  if (!['active', 'disabled'].includes(b.status)) throw new HttpError(400, 'Bad status');
  const s = db.prepare('SELECT s.*, l.key k FROM servers s JOIN licenses l ON l.id=s.license_id WHERE s.id=? AND l.workspace_id=?').get(ctx.params.id, ctx.wsId);
  if (!s) throw new HttpError(404, 'Not found');
  db.prepare('UPDATE servers SET status=? WHERE id=?').run(b.status, s.id);
  wl(ctx, b.status === 'disabled' ? 'server.disable' : 'server.enable', s.k, `${s.ip}:${s.port} ${s.name}`);
  return [200, { ok: true }];
}, { admin: true });
route('DELETE', '/api/admin/servers/:id', async ctx => {
  const s = db.prepare('SELECT s.*, l.key k FROM servers s JOIN licenses l ON l.id=s.license_id WHERE s.id=? AND l.workspace_id=?').get(ctx.params.id, ctx.wsId);
  if (!s) throw new HttpError(404, 'Not found');
  db.prepare("UPDATE servers SET status='removed' WHERE id=?").run(s.id); // plugin learns about it on next heartbeat
  wl(ctx, 'server.remove', s.k, `${s.ip}:${s.port} ${s.name}`);
  return [200, { ok: true }];
}, { admin: true });

// Admin: products (plugin downloads) ------------------------------------------
const productFile = slug => join(PRODUCTS_DIR, slug + '.bin');
const downloadUrlFor = (req, p) => {
  const origin = PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost:' + PORT}`;
  return `${origin}/download/${p.slug}?token=${p.token}`;
};
const productRow = (req, p) => {
  const { wrap_ok, wrap_code, wrap_message, main_class, ...rest } = p;
  return { ...rest, download_url: downloadUrlFor(req, p),
    integration: !p.has_file ? null : { ok: !!wrap_ok, integrated: wrap_code === 'ALREADY_INTEGRATED', code: wrap_code, message: wrap_message, main: main_class } };
};
const publicBase = req => PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
route('GET', '/api/admin/products', async ctx => {
  const rows = db.prepare('SELECT * FROM products WHERE workspace_id=? ORDER BY id DESC').all(ctx.wsId);
  return [200, rows.map(p => productRow(ctx.req, p))];
}, { admin: true });
route('POST', '/api/admin/products', async ctx => {
  const b = await body(ctx.req);
  const name = str(b.name, 60).trim();
  if (!name) throw new HttpError(400, 'Name required');
  const group_id = ownGroup(ctx, b.group_id ? int(b.group_id, { min: 1 }) : null);
  withinPlan(() => core.assertWithin(ctx.wsId, 'products'));
  let slug = slugify(b.slug || name), base = slug, i = 2;
  while (db.prepare('SELECT 1 FROM products WHERE slug=?').get(slug)) slug = `${base}-${i++}`;
  const r = db.prepare('INSERT INTO products(workspace_id,slug,name,token,group_id,created_at) VALUES(?,?,?,?,?,?)').run(ctx.wsId, slug, name, randomBytes(12).toString('base64url'), group_id, now());
  wl(ctx, 'product.create', slug, name);
  return [201, productRow(ctx.req, db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid))];
}, { admin: true });
/** Stores `buf` as the plugin file of product `p` and records whether it can be wrapped. */
function setProductFile(ctx, p, buf, filename) {
  try { injectFiles(buf, [{ name: '.licensex-probe', content: '1' }]); }
  catch { throw new HttpError(400, 'That file is not a valid .jar archive.'); }
  writeFileSync(productFile(p.slug), buf);
  const w = checkWrappable(buf);
  db.prepare('UPDATE products SET filename=?, size=?, has_file=1, wrap_ok=?, wrap_code=?, wrap_message=?, main_class=? WHERE id=?')
    .run(filename, buf.length, w.ok ? 1 : 0, w.code, w.message, w.main || '', p.id);
  wl(ctx, 'product.upload', p.slug, `${filename} ${buf.length}B ${w.ok ? 'integrated:' + w.main : w.code}`);
}
// Raw binary upload (the plugin jar). Streamed to disk, not parsed as JSON.
route('POST', '/api/admin/products/:id/file', async ctx => {
  const p = ownProduct(ctx, ctx.params.id);
  const filename = str(ctx.req.headers['x-filename'] || 'plugin.jar', 80);
  const size = await saveUpload(ctx.req, productFile(p.slug));
  // Reject anything that isn't a readable zip/jar, so download-time stamping can't fail later.
  try { injectFiles(readFileSync(productFile(p.slug)), [{ name: '.licensex-probe', content: '1' }]); }
  catch { rmSync(productFile(p.slug), { force: true }); throw new HttpError(400, 'That file is not a valid .jar/.zip archive.'); }
  const w = checkWrappable(readFileSync(productFile(p.slug)));
  db.prepare('UPDATE products SET filename=?, size=?, has_file=1, wrap_ok=?, wrap_code=?, wrap_message=?, main_class=? WHERE id=?')
    .run(filename, size, w.ok ? 1 : 0, w.code, w.message, w.main || '', p.id);
  wl(ctx, 'product.upload', p.slug, `${filename} ${size}B ${w.ok ? 'integrated:' + w.main : w.code}`);
  return [200, productRow(ctx.req, db.prepare('SELECT * FROM products WHERE id=?').get(p.id))];
}, { admin: true });
// The jar to upload to BuiltByBit: wrapped, but with no key. BuiltByBit overwrites %%__BBB_LICENSE__%% per buyer.
route('GET', '/api/admin/products/:id/bbb-build', async ctx => {
  const p = ownProduct(ctx, ctx.params.id);
  if (!p.has_file) throw new HttpError(404, 'Upload a plugin file first.');
  const stem = (p.filename || p.slug + '.jar').replace(/\.(jar|zip)$/i, '').replace(/[^\w.\-]/g, '_');
  return [200, licensedJar(ctx.req, p, ''), { 'Content-Type': 'application/java-archive', 'Content-Disposition': `attachment; filename="${stem}-builtbybit.jar"` }];
}, { admin: true });
route('PATCH', '/api/admin/products/:id', async ctx => {
  const p = ownProduct(ctx, ctx.params.id);
  const b = await body(ctx.req), f = {};
  if ('name' in b) { f.name = str(b.name, 60).trim(); if (!f.name) throw new HttpError(400, 'Name required'); }
  if ('enabled' in b) f.enabled = b.enabled ? 1 : 0;
  if ('group_id' in b) f.group_id = ownGroup(ctx, b.group_id ? int(b.group_id, { min: 1 }) : null);
  if (b.regenerate_token) f.token = randomBytes(12).toString('base64url');
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE products SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => f[k]), p.id);
  wl(ctx, 'product.update', p.slug, JSON.stringify(f).replace(/"token":"[^"]+"/, '"token":"***"'));
  return [200, productRow(ctx.req, db.prepare('SELECT * FROM products WHERE id=?').get(p.id))];
}, { admin: true });
route('DELETE', '/api/admin/products/:id', async ctx => {
  const p = ownProduct(ctx, ctx.params.id);
  rmSync(productFile(p.slug), { force: true });
  db.prepare('DELETE FROM products WHERE id=?').run(p.id);
  wl(ctx, 'product.delete', p.slug, p.name);
  return [200, { ok: true }];
}, { admin: true });

// Admin: build from source ---------------------------------------------------------
// Upload a Maven/Gradle project as a zip -> inspection report -> build -> jar (optionally straight into a product).
// See docs/BUILD.md for what this does and does not protect against.
const builds = createBuildService({ baseDir: join(DATA, 'builds') });
setInterval(() => builds.sweep(), 3600e3).unref();
const asHttp = fn => { try { return fn(); } catch (e) { if (e instanceof BuildError) throw new HttpError(e.status, e.message); throw e; } };
route('GET', '/api/admin/builds/tools', async () => [200, builds.tools()], { platform: true });
route('GET', '/api/admin/builds', async () => [200, builds.list()], { platform: true });
route('POST', '/api/admin/builds', async ctx => {
  const tmp = join(DATA, '.build-upload-' + randomBytes(4).toString('hex'));
  const filename = str(ctx.req.headers['x-filename'] || 'source.zip', 80);
  try {
    await saveUpload(ctx.req, tmp);
    const job = asHttp(() => builds.create(readFileSync(tmp), filename));
    wl(ctx, 'build.upload', job.id, `${filename} ${job.report.kind} findings=${job.report.findings.length}`);
    return [201, job];
  } finally { rmSync(tmp, { force: true }); }
}, { platform: true });
route('GET', '/api/admin/builds/:id', async ctx => { const j = builds.get(ctx.params.id); if (!j) throw new HttpError(404, 'Build not found'); return [200, j]; }, { platform: true });
route('POST', '/api/admin/builds/:id/build', async ctx => {
  const b = await body(ctx.req);
  const job = asHttp(() => builds.start(ctx.params.id, { trust: b.trust === true }));
  wl(ctx, 'build.start', job.id, `${job.filename} trusted=${job.trusted}`);
  return [202, job];
}, { platform: true });
route('GET', '/api/admin/builds/:id/jar', async ctx => {
  const f = builds.jarFile(ctx.params.id);
  if (!f) throw new HttpError(404, 'No jar for this build');
  return [200, readFileSync(f.path), { 'Content-Type': 'application/java-archive', 'Content-Disposition': `attachment; filename="${f.name.replace(/[^\w.\-]/g, '_')}"` }];
}, { platform: true });
// Put the built jar into a product: replace an existing product's file, or create a new product from it.
route('POST', '/api/admin/builds/:id/product', async ctx => {
  const b = await body(ctx.req);
  const f = builds.jarFile(ctx.params.id);
  if (!f) throw new HttpError(404, 'No jar for this build');
  let p;
  if (b.productId) p = ownProduct(ctx, int(b.productId, { min: 1 }));
  else {
    const name = str(b.name, 60).trim();
    if (!name) throw new HttpError(400, 'Give the new product a name, or pick an existing product.');
    withinPlan(() => core.assertWithin(ctx.wsId, 'products'));
    let slug = slugify(name), base = slug, i = 2;
    while (db.prepare('SELECT 1 FROM products WHERE slug=?').get(slug)) slug = `${base}-${i++}`;
    const r = db.prepare('INSERT INTO products(workspace_id,slug,name,token,created_at) VALUES(?,?,?,?,?)').run(ctx.wsId, slug, name, randomBytes(12).toString('base64url'), now());
    p = db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid);
    wl(ctx, 'product.create', slug, name);
  }
  setProductFile(ctx, p, readFileSync(f.path), f.name);
  return [200, productRow(ctx.req, db.prepare('SELECT * FROM products WHERE id=?').get(p.id))];
}, { platform: true });
route('DELETE', '/api/admin/builds/:id', async ctx => { asHttp(() => builds.remove(ctx.params.id)); return [200, { ok: true }]; }, { platform: true });

// Admin: backup / restore ---------------------------------------------------------
// Everything (licenses, servers, groups, settings, uploaded plugins) in one zip. Contains every license key and the
// BuiltByBit secret, so treat it like a password. Restoring replaces all current data.
route('GET', '/api/admin/backup', async () => {
  const zip = createBackup(db, PRODUCTS_DIR);
  core.log('admin', 'backup.download', '', `${zip.length}B`);
  return [200, zip, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="licensex-backup-${new Date().toISOString().slice(0, 10)}.zip"` }];
}, { platform: true });
route('POST', '/api/admin/restore', async ctx => {
  const tmp = join(DATA, '.restore-upload');
  await saveUpload(ctx.req, tmp);
  try {
    const r = restoreBackup(db, PRODUCTS_DIR, readFileSync(tmp), DatabaseSync);
    core.log('admin', 'backup.restore', '', `${r.products} plugin file(s)`);
    return [200, { ok: true, ...r }];
  } catch (e) {
    if (e instanceof RestoreError) throw new HttpError(400, e.message);
    throw e;
  } finally { rmSync(tmp, { force: true }); }
}, { platform: true });

// Admin: groups ---------------------------------------------------------------
const groupFields = b => {
  const name = str(b.name, 40).trim();
  if (!name) throw new HttpError(400, 'Name required');
  const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#8b5cf6';
  return [name, int(b.max_servers, { min: -1, max: 100000 }), color];
};
route('GET', '/api/admin/groups', async ctx => [200, db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM licenses WHERE group_id=g.id) licenses FROM license_groups g WHERE g.workspace_id=? ORDER BY g.id`).all(ctx.wsId)], { admin: true });
route('POST', '/api/admin/groups', async ctx => {
  const [name, max, color] = groupFields(await body(ctx.req));
  try { db.prepare('INSERT INTO license_groups(workspace_id,name,max_servers,color,created_at) VALUES(?,?,?,?,?)').run(ctx.wsId, name, max, color, now()); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A group with that name exists'); throw e; }
  wl(ctx, 'group.create', name, `limit=${max}`);
  return [201, { ok: true }];
}, { admin: true });
route('PATCH', '/api/admin/groups/:id', async ctx => {
  const [name, max, color] = groupFields(await body(ctx.req));
  let r;
  try { r = db.prepare('UPDATE license_groups SET name=?, max_servers=?, color=? WHERE id=? AND workspace_id=?').run(name, max, color, ctx.params.id, ctx.wsId); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A group with that name exists'); throw e; }
  if (!r.changes) throw new HttpError(404, 'Not found');
  wl(ctx, 'group.update', name, `limit=${max}`);
  return [200, { ok: true }];
}, { admin: true });
route('DELETE', '/api/admin/groups/:id', async ctx => {
  const r = db.prepare('DELETE FROM license_groups WHERE id=? AND workspace_id=?').run(ctx.params.id, ctx.wsId);
  if (!r.changes) throw new HttpError(404, 'Not found');
  wl(ctx, 'group.delete', ctx.params.id);
  return [200, { ok: true }];
}, { admin: true });

// Admin: settings + audit -----------------------------------------------------
const WS_SETTING_KEYS = ['default_limit', 'claims_enabled', 'public_removal', 'heartbeat_minutes', 'bbb_group_id'];
route('GET', '/api/admin/settings', async ctx => {
  const w = ctx.wsId;
  const out = {
    role: ctx.admin.role,
    ...Object.fromEntries(WS_SETTING_KEYS.map(k => [k, core.getSetting(k, w)])),
    bbb_secret: bbbSecretOf(w),
    bbb_callback_url: `${publicBase(ctx.req)}/api/v1/builtbybit/license`,
  };
  if (ctx.admin.role === 'platform') Object.assign(out, {
    ...Object.fromEntries(SITE_KEYS.map(k => [k, core.getSetting(k)])),
    admin_emails: parseEmails(core.getSetting('admin_emails')), admin_emails_config: CONFIG_ADMIN_EMAILS, password_login: !DISABLE_PASSWORD_LOGIN,
    oauth: Object.fromEntries(Object.keys(PROVIDERS).map(p => [p, { label: PROVIDERS[p].label, configured: !!oauthConf[p], callback_url: `${publicBase(ctx.req)}/auth/${p}/callback` }])),
    stripe: { configured: !!STRIPE.secretKey, webhook_configured: !!STRIPE.webhookSecret, webhook_url: `${publicBase(ctx.req)}/api/stripe/webhook` },
  });
  return [200, out];
}, { admin: true });
const httpUrl = (v, label) => {
  v = String(v ?? '').trim().slice(0, 300);
  if (!v) return '';
  let u; try { u = new URL(v); } catch { throw new HttpError(400, `${label} must be a full link, e.g. https://discord.gg/yourinvite`); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, `${label} must start with http:// or https://`);
  return u.href;
};
const PLATFORM_SETTING_KEYS = [...SITE_KEYS, 'admin_emails'];
route('PUT', '/api/admin/settings', async ctx => {
  const b = await body(ctx.req), w = ctx.wsId;
  if (ctx.admin.role !== 'platform' && PLATFORM_SETTING_KEYS.some(k => k in b)) throw new HttpError(403, 'Only the site owner can change those settings.');
  if ('default_limit' in b) core.setSetting('default_limit', int(b.default_limit, { min: -1, max: 100000 }), w);
  if ('heartbeat_minutes' in b) core.setSetting('heartbeat_minutes', int(b.heartbeat_minutes, { min: 1, max: 1440 }), w);
  for (const k of ['claims_enabled', 'public_removal']) if (k in b) core.setSetting(k, b[k] ? '1' : '0', w);
  if ('bbb_group_id' in b) core.setSetting('bbb_group_id', ownGroup(ctx, b.bbb_group_id ? int(b.bbb_group_id, { min: 1 }) : null) ?? '', w);
  if (b.regenerate_bbb_secret) db.prepare('UPDATE workspaces SET bbb_secret=? WHERE id=?').run(newSecret(), w);
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
  if ('admin_emails' in b) {
    const list = parseEmails(b.admin_emails);
    const bad = list.find(e => !EMAIL_RE.test(e));
    if (bad) throw new HttpError(400, `"${bad}" is not a valid email address`);
    if (list.length > 100) throw new HttpError(400, 'At most 100 admin emails');
    core.setSetting('admin_emails', list.join('\n'));
  }
  wl(ctx, 'settings.update', '', JSON.stringify({ ...b, bbb_secret: undefined }));
  return [200, { ok: true }];
}, { admin: true });
route('GET', '/api/admin/audit', async ctx => [200, db.prepare('SELECT * FROM audit WHERE workspace_id=? ORDER BY id DESC LIMIT ?').all(ctx.wsId, Math.min(Number(ctx.url.searchParams.get('limit')) || 100, 500))], { admin: true });

// Workspaces, plans and billing ----------------------------------------------------
const billing = createBilling({ db, core, cfg: STRIPE, log: (a, t, d) => console.error(`[LicenseX] ${a} ${t} ${d}`) });
const slugKey = /^[a-z0-9][a-z0-9-]{1,23}$/;
const planView = p => ({ key: p.key, name: p.name, description: p.description, price_cents: p.price_cents, currency: p.currency, interval: p.interval,
  max_products: p.max_products, max_licenses: p.max_licenses, features: p.features.split('\n').map(x => x.trim()).filter(Boolean), highlight: !!p.highlight });
const asStripeHttp = async fn => { try { return await fn(); } catch (e) { if (e instanceof StripeError) throw new HttpError(e.status, e.message); throw e; } };

function workspaceSummary(w) {
  const plan = core.planOf(w.id), entitled = core.entitledPlanKey(w);
  return { id: w.id, name: w.name, house: w.id === HOUSE, owner_email: w.owner_email, created_at: w.created_at,
    suspended: !!w.suspended, suspended_reason: w.suspended_reason,
    plan: planView({ features: '', currency: 'usd', description: '', highlight: 0, ...plan }),
    plan_key: w.plan_key, plan_status: w.plan_status, plan_until: w.plan_until, plan_source: w.plan_source,
    lapsed: w.plan_key !== 'free' && entitled === 'free', usage: core.usage(w.id),
    billing: { stripe: billing.enabled(), can_portal: billing.enabled() && !!w.stripe_customer_id } };
}
route('GET', '/api/workspace', async ctx => [200, workspaceSummary(db.prepare('SELECT * FROM workspaces WHERE id=?').get(ctx.wsId))], { admin: true, allowSuspended: true });

// Public pricing: the plans that are for sale, whether card payments are on, and how else to reach the owner.
route('GET', '/api/public/pricing', async ctx => {
  const plans = db.prepare('SELECT * FROM plans WHERE active=1 ORDER BY sort, price_cents').all().map(planView);
  const u = sessionUser(ctx.req), w = workspaceOfUser(u);
  return [200, { plans, payments: billing.enabled(), site: Object.fromEntries(SITE_KEYS.map(k => [k, core.getSetting(k)])),
    current: w ? { plan_key: core.entitledPlanKey(w), status: w.plan_status, until: w.plan_until } : null }];
});

// A signed-in person gets their own private workspace (on the Free plan). Needs a verified email: that is who owns it.
route('POST', '/api/workspace/ensure', async ctx => {
  const u = sessionUser(ctx.req);
  if (!u) throw new HttpError(401, 'Sign in first.');
  const existing = workspaceOfUser(u);
  if (existing) return [200, workspaceSummary(existing)];
  if (!u.email) throw new HttpError(400, `${u.p} did not share a verified email address, so we cannot create an account. Sign in with a provider that does.`);
  if (!rateLimit('ws:' + ctx.ip, Number(process.env.LICENSEX_SIGNUPS_PER_IP_HOUR || 10), 3600e3)) throw new HttpError(429, 'Too many accounts created from this address. Try again later.');
  const r = db.prepare('INSERT INTO workspaces (name, owner_email, owner_name, bbb_secret, created_at) VALUES (?,?,?,?,?)')
    .run(str(u.name, 60) || u.email.split('@')[0], u.email, str(u.name, 80), newSecret(), now());
  core.log('user', 'workspace.create', u.email, u.p, Number(r.lastInsertRowid));
  return [201, workspaceSummary(db.prepare('SELECT * FROM workspaces WHERE id=?').get(r.lastInsertRowid))];
});

route('POST', '/api/billing/checkout', async ctx => {
  const u = sessionUser(ctx.req);
  if (!u) throw new HttpError(401, 'Sign in first.');
  if (!rateLimit('checkout:' + (u.email || u.id), 10, 60e3)) throw new HttpError(429, 'Slow down a little.');
  const b = await body(ctx.req);
  const plan = db.prepare('SELECT * FROM plans WHERE key=? AND active=1').get(str(b.plan, 30));
  if (!plan || plan.price_cents <= 0) throw new HttpError(400, 'That plan is not for sale.');
  if (!billing.enabled()) throw new HttpError(503, 'Online payments are not set up yet. Please contact us to buy this plan.');
  let w = workspaceOfUser(u);
  if (!w) { if (!u.email) throw new HttpError(400, 'Your sign-in did not share a verified email address, so we cannot create an account.'); w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(Number(db.prepare('INSERT INTO workspaces (name, owner_email, owner_name, bbb_secret, created_at) VALUES (?,?,?,?,?)').run(str(u.name, 60) || u.email.split('@')[0], u.email, str(u.name, 80), newSecret(), now()).lastInsertRowid)); }
  const entitled = core.entitledPlanKey(w);
  if (entitled === plan.key && plan.interval === 'once') throw new HttpError(409, `You already have the ${plan.name} plan.`);
  if (w.stripe_subscription_id && w.plan_source === 'stripe' && entitled !== 'free' && w.plan_status !== 'canceled')
    throw new HttpError(409, 'You already have an active subscription. Open Billing in your dashboard to change or cancel it.');
  const url = await asStripeHttp(() => billing.checkout({ ws: w, plan, email: u.email, siteName: core.getSetting('site_name'), base: publicBase(ctx.req) }));
  core.log('user', 'billing.checkout', plan.key, u.email, w.id);
  return [200, { url }];
});
route('POST', '/api/billing/portal', async ctx => {
  const u = sessionUser(ctx.req), w = workspaceOfUser(u);
  if (!w) throw new HttpError(401, 'Sign in first.');
  return [200, { url: await asStripeHttp(() => billing.portal({ ws: w, base: publicBase(ctx.req) })) }];
});

// Stripe calls this. The signature is checked against the exact bytes received, and nothing is trusted before that.
route('POST', '/api/stripe/webhook', async ctx => {
  if (!STRIPE.webhookSecret) throw new HttpError(503, 'Webhook secret not configured');
  const chunks = []; let size = 0;
  for await (const c of ctx.req) { size += c.length; if (size > 1024 * 1024) throw new HttpError(413, 'Too large'); chunks.push(c); }
  const raw = Buffer.concat(chunks);
  if (!verifySignature(raw, ctx.req.headers['stripe-signature'], STRIPE.webhookSecret)) throw new HttpError(400, 'Bad signature');
  let event; try { event = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON'); }
  try { return [200, { received: true, note: billing.handleEvent(event) }]; }
  catch (e) { console.error('[LicenseX] stripe event failed:', e.message); throw new HttpError(500, 'Handler failed (Stripe will retry)'); }
});

// Platform: customers ------------------------------------------------------------
const customerRow = w => ({ ...workspaceSummary(w), licenses: core.usage(w.id).licenses, products: core.usage(w.id).products,
  stripe_customer_id: w.stripe_customer_id, stripe_subscription_id: w.stripe_subscription_id });
route('GET', '/api/admin/customers', async () => [200, db.prepare('SELECT * FROM workspaces ORDER BY id').all().map(customerRow)], { platform: true });
const customer = ctx => { const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(ctx.params.id); if (!w) throw new HttpError(404, 'Not found'); if (w.id === HOUSE) throw new HttpError(400, 'That is your own workspace.'); return w; };
// Hand-granting a plan (gifts, friends, other payment methods). until=null means no end date.
route('POST', '/api/admin/customers/:id/plan', async ctx => {
  const w = customer(ctx), b = await body(ctx.req);
  const plan = db.prepare('SELECT * FROM plans WHERE key=?').get(str(b.plan_key, 30));
  if (!plan) throw new HttpError(400, 'Unknown plan');
  const until = int(b.until, { min: 1, max: 4e10, nullable: true });
  db.prepare("UPDATE workspaces SET plan_key=?, plan_status='active', plan_until=?, plan_source=? WHERE id=?").run(plan.key, plan.key === 'free' ? null : until, plan.key === 'free' ? 'free' : 'manual', w.id);
  core.log('admin', 'customer.plan', `${w.owner_email} -> ${plan.key}`, until ? `until ${new Date(until * 1000).toISOString().slice(0, 10)}` : 'no end date', w.id);
  return [200, customerRow(db.prepare('SELECT * FROM workspaces WHERE id=?').get(w.id))];
}, { platform: true });
route('POST', '/api/admin/customers/:id/suspend', async ctx => {
  const w = customer(ctx), b = await body(ctx.req);
  db.prepare('UPDATE workspaces SET suspended=?, suspended_reason=? WHERE id=?').run(b.suspended ? 1 : 0, b.suspended ? str(b.reason, 200) : '', w.id);
  core.log('admin', b.suspended ? 'customer.suspend' : 'customer.unsuspend', w.owner_email, str(b.reason, 200), w.id);
  return [200, customerRow(db.prepare('SELECT * FROM workspaces WHERE id=?').get(w.id))];
}, { platform: true });
route('DELETE', '/api/admin/customers/:id', async ctx => {
  const w = customer(ctx);
  for (const p of db.prepare('SELECT slug FROM products WHERE workspace_id=?').all(w.id)) rmSync(productFile(p.slug), { force: true });
  db.exec('BEGIN');
  try {
    for (const t of ['licenses', 'products', 'license_groups', 'ws_settings', 'audit']) db.prepare(`DELETE FROM ${t} WHERE workspace_id=?`).run(w.id); // servers go with their licenses
    db.prepare('DELETE FROM workspaces WHERE id=?').run(w.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  core.log('admin', 'customer.delete', w.owner_email, `workspace ${w.id}`);
  return [200, { ok: true }];
}, { platform: true });

// Platform: plans -------------------------------------------------------------------
const planFields = (b, existing) => {
  const key = existing ? existing.key : str(b.key, 24).trim().toLowerCase();
  if (!existing && !slugKey.test(key)) throw new HttpError(400, 'Plan key: 2-24 lowercase letters, digits or dashes.');
  const name = str(b.name, 40).trim(); if (!name) throw new HttpError(400, 'Name required');
  const interval = key === 'free' ? 'free' : str(b.interval, 10);
  if (!['free', 'month', 'year', 'once'].includes(interval) || (key !== 'free' && interval === 'free')) throw new HttpError(400, 'Billing must be monthly, yearly or one-time.');
  const price = key === 'free' ? 0 : int(b.price_cents, { min: 100, max: 1_000_000_00 });
  const currency = str(b.currency || 'usd', 3).toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new HttpError(400, 'Currency is a 3-letter code such as usd or eur.');
  const features = String(b.features ?? '').split('\n').map(x => x.trim().slice(0, 90)).filter(Boolean).slice(0, 14).join('\n');
  return { key, name, description: str(b.description, 140).trim(), price_cents: price, currency, interval,
    max_products: int(b.max_products, { min: -1, max: 100000 }), max_licenses: int(b.max_licenses, { min: -1, max: 10000000 }),
    features, highlight: b.highlight ? 1 : 0, active: b.active === false ? 0 : 1, sort: int(b.sort ?? 0, { min: 0, max: 1000 }) };
};
route('GET', '/api/admin/plans', async () => [200, db.prepare('SELECT p.*, (SELECT COUNT(*) FROM workspaces w WHERE w.plan_key = p.key) customers FROM plans p ORDER BY sort, price_cents').all()], { platform: true });
route('POST', '/api/admin/plans', async ctx => {
  const f = planFields(await body(ctx.req), null);
  if (db.prepare('SELECT 1 FROM plans WHERE key=?').get(f.key)) throw new HttpError(409, 'A plan with that key exists');
  db.prepare('INSERT INTO plans (key,name,description,price_cents,currency,interval,max_products,max_licenses,features,highlight,active,sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(f.key, f.name, f.description, f.price_cents, f.currency, f.interval, f.max_products, f.max_licenses, f.features, f.highlight, f.active, f.sort);
  core.log('admin', 'plan.create', f.key, f.name);
  return [201, { ok: true }];
}, { platform: true });
route('PATCH', '/api/admin/plans/:key', async ctx => {
  const cur = db.prepare('SELECT * FROM plans WHERE key=?').get(ctx.params.key);
  if (!cur) throw new HttpError(404, 'Not found');
  const f = planFields({ ...cur, ...(await body(ctx.req)) }, cur);
  db.prepare('UPDATE plans SET name=?,description=?,price_cents=?,currency=?,interval=?,max_products=?,max_licenses=?,features=?,highlight=?,active=?,sort=? WHERE key=?')
    .run(f.name, f.description, f.price_cents, f.currency, f.interval, f.max_products, f.max_licenses, f.features, f.highlight, f.key === 'free' ? 1 : f.active, f.sort, f.key);
  core.log('admin', 'plan.update', f.key, `${f.price_cents}${f.currency}/${f.interval}`);
  return [200, { ok: true }];
}, { platform: true });
route('DELETE', '/api/admin/plans/:key', async ctx => {
  if (ctx.params.key === 'free') throw new HttpError(400, 'The Free plan cannot be deleted.');
  if (db.prepare('SELECT 1 FROM workspaces WHERE plan_key=?').get(ctx.params.key)) throw new HttpError(409, 'Customers are on this plan. Hide it instead (untick Active).');
  const r = db.prepare('DELETE FROM plans WHERE key=?').run(ctx.params.key);
  if (!r.changes) throw new HttpError(404, 'Not found');
  core.log('admin', 'plan.delete', ctx.params.key);
  return [200, { ok: true }];
}, { platform: true });

// --- licensed jar builder ---------------------------------------------------
// Wraps the uploaded plugin so it checks its license before starting. A plugin that already contains the LicenseX
// client only needs its licensex.json. Anything else that can't be wrapped is refused rather than served
// unprotected: a license system must never silently hand out a jar that doesn't enforce the license.
function licensedJar(req, p, key) {
  const jar = readFileSync(productFile(p.slug));
  const cfg = { url: publicBase(req), key, product: p.name };
  try { return wrapJar(jar, cfg).jar; }
  catch (e) {
    if (!(e instanceof WrapError)) throw e;
    if (e.code === 'ALREADY_INTEGRATED') return injectFiles(jar, [{ name: 'licensex.json', content: JSON.stringify({ ...cfg, issued: now() }) }]);
    throw new HttpError(503, `This download is unavailable: ${e.message}`, e.code);
  }
}

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
  const r = core.claim({ ws: p.workspace_id, nonce: nonce.includes('%%') || !nonce ? 'anon-' + randomBytes(12).toString('hex') : nonce,
    user: str(url.searchParams.get('user'), 64), name: str(url.searchParams.get('name'), 64), product: p.name, group_id: p.group_id, ip, device: hash(ip + req.headers['user-agent']) });
  if (!r.ok) throw new HttpError(r.code === 'PLAN_LIMIT' ? 402 : 403, r.message, r.code);

  const stamped = licensedJar(req, p, r.key);
  db.prepare('UPDATE products SET downloads = downloads + 1 WHERE id=?').run(p.id);
  core.log('system', 'product.download', p.slug, `${r.key} ip=${ip}`, p.workspace_id);

  const dlName = (p.filename && /\.(jar|zip)$/i.test(p.filename) ? p.filename : slugify(p.name) + '.jar');
  res.writeHead(200, { 'Content-Type': 'application/java-archive', 'Content-Length': stamped.length,
    'Content-Disposition': `attachment; filename="${dlName.replace(/[^\w.\-]/g, '_')}"`, 'Cache-Control': 'no-store' });
  res.end(stamped);
}

// --- static + dispatch -----------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/dashboard') pathname = '/admin.html';
  if (pathname === '/pricing') pathname = '/pricing.html';
  if (pathname === '/login') pathname = '/login.html';
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
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com https://avatars.githubusercontent.com https://cdn.discordapp.com; frame-ancestors 'none'");
  try {
    const dl = url.pathname.match(/^\/download\/([a-z0-9-]{1,48})$/);
    if (dl) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return handleDownload(req, res, dl[1], url);
    }
    if (url.pathname.startsWith('/auth/')) return await handleAuth(req, res, url);
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, decodeURIComponent(url.pathname));
    }
    for (const [method, re, handler, opts] of routes) {
      const m = req.method === method && re.exec(url.pathname);
      if (!m) continue;
      const admin = adminIdentity(req);
      let wsId = HOUSE;
      if (opts.admin || opts.platform) {
        if (!admin) throw new HttpError(401, 'Not signed in');
        if (opts.platform && admin.role !== 'platform') throw new HttpError(403, 'Only the site owner can do that.');
        wsId = resolveWorkspace(admin, req, url);
        // A suspended customer can still look around (and read their data), but nothing can be changed.
        if (admin.role === 'tenant' && req.method !== 'GET' && core.isSuspended(wsId) && !opts.allowSuspended) throw new HttpError(403, 'This account is suspended. Contact support.');
      }
      const [status, payload, headers] = await handler({ req, url, params: m.groups || {}, ip: clientIp(req), admin, wsId });
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
