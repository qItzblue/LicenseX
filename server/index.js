import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, createReadStream, createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { openDb, DatabaseSync } from './db.js';
import { createBackup, restoreBackup, RestoreError, backupFiles, zipFiles } from './backup.js';
import { createOffsite, offsiteConfig, withoutProducts, isEncrypted, decrypt } from './offsite.js';
import { createBuildService, BuildError } from './builder.js';
import { planForResource, planSalesSecret, issuePlanKey, lookupKey, redeemKey, registerPlanSales, RedeemError } from './plansales.js';
import { providerDefs, authorizeUrl, exchangeCode, fetchProfile, parseEmails, normEmail, EMAIL_RE } from './auth.js';
import { createCore, normalizeKey, KEY_RE, hash, now, PlanError, HOUSE } from './core.js';
import { injectFiles, listEntries, readEntry, setZipComment, readZipComment } from './jarstamp.js';
import { wrapJar, checkWrappable, readWrappedConfig, WrapError } from './wrapjar.js';
import { registerBuyers } from './buyers.js';
import { registerTeam } from './team.js';
import { registerPatreon } from './patreon.js';
import { accessFor, slotsFor } from './rbac.js';
import { createTwoFactor, otpauthUri, subjectForEmail, PASSWORD_SUBJECT } from './twofa.js';

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
// How many reverse proxies sit in front of this server (Render = 1; Cloudflare in front of Render = 2). Only used with TRUST_PROXY.
const PROXY_HOPS = Math.max(1, Math.floor(Number(process.env.LICENSEX_PROXY_HOPS || fileConfig.proxyHops || 1)) || 1);

// "Sign in with ..." (see docs/LOGIN.md). A provider is on when both its client id and secret are set.
const PROVIDERS = providerDefs(process.env.LICENSEX_OAUTH_TEST_BASE);
const oauthConf = {};
for (const p of Object.keys(PROVIDERS)) {
  const id = process.env[`LICENSEX_${p.toUpperCase()}_CLIENT_ID`] || fileConfig.oauth?.[p]?.clientId;
  const secret = process.env[`LICENSEX_${p.toUpperCase()}_CLIENT_SECRET`] || fileConfig.oauth?.[p]?.clientSecret;
  if (id && secret) oauthConf[p] = { clientId: String(id), clientSecret: String(secret) };
}
// Emails that are admins no matter what the database says (so you can never lock yourself out of the settings page).
const CONFIG_ADMIN_EMAILS = parseEmails(process.env.LICENSEX_ADMIN_EMAILS ?? fileConfig.adminEmails ?? '');
// 'closed' = only people you give a plan to by hand can have a workspace (no self-service signup)
const SIGNUPS_OPEN = String(process.env.LICENSEX_SIGNUPS ?? fileConfig.signups ?? 'open').toLowerCase() !== 'closed';
const DISABLE_PASSWORD_LOGIN = process.env.LICENSEX_DISABLE_PASSWORD_LOGIN === '1' || fileConfig.disablePasswordLogin === true;
if (DISABLE_PASSWORD_LOGIN && (!Object.keys(oauthConf).length || !CONFIG_ADMIN_EMAILS.length)) {
  console.error('[LicenseX] disablePasswordLogin needs at least one sign-in provider and one admin email in the config, or nobody could log in.');
  process.exit(1);
}

mkdirSync(DATA, { recursive: true });
mkdirSync(PRODUCTS_DIR, { recursive: true });
const DB_PATH = process.env.LICENSEX_DB || join(DATA, 'licensex.db');
const freshDisk = !existsSync(DB_PATH);
const db = openDb(DB_PATH);
const core = createCore(db);

// Off-site backups (server/offsite.js). On a wiped disk the newest copy is put back before anything else happens.
const OFFSITE = offsiteConfig(process.env, fileConfig);
const offsite = createOffsite({ config: OFFSITE, log: (action, target, detail) => core.log('system', action, target, detail),
  snapshot: () => { const { files, digest } = backupFiles(db, PRODUCTS_DIR); return { zip: zipFiles(files), digest, small: withoutProducts(files) }; } });
const looksEmpty = () => !db.prepare('SELECT 1 FROM licenses LIMIT 1').get() && !db.prepare('SELECT 1 FROM products LIMIT 1').get() && db.prepare('SELECT COUNT(*) n FROM workspaces').get().n <= 1;
if (offsite.enabled && OFFSITE.restoreOnStart && (freshDisk || looksEmpty())) {
  try {
    const zip = await offsite.fetchLatest();
    if (zip) {
      const r = restoreBackup(db, PRODUCTS_DIR, zip, DatabaseSync);
      core.log('system', 'backup.auto-restore', '', `${r.products} plugin file(s)`);
      offsite.markRestored({ ok: true, products: r.products });
      console.log(`[LicenseX] Empty disk: restored the latest off-site backup (${r.products} plugin file(s)).`);
    } else console.log('[LicenseX] Empty disk and no off-site backup yet: starting fresh.');
  } catch (e) {
    offsite.markRestored({ ok: false, error: e.message });
    console.error(`[LicenseX] Could not restore the off-site backup: ${e.message}. Starting with what is on disk; nothing is backed up over the old copy until you check.`);
    OFFSITE.blocked = true;
  }
}
const twofa = createTwoFactor(db);
// Locked out (lost phone and recovery codes)? Start once with LICENSEX_RESET_2FA=password (or an email address) to switch it off.
for (const who of parseEmails(process.env.LICENSEX_RESET_2FA || '')) {
  const subject = who === PASSWORD_SUBJECT ? PASSWORD_SUBJECT : subjectForEmail(who);
  if (twofa.remove(subject)) { core.log('system', '2fa.reset', who, 'LICENSEX_RESET_2FA'); console.log(`[LicenseX] Two-factor sign-in switched off for ${who}. Remove LICENSEX_RESET_2FA again.`); }
}

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
/** Admin-password session: "<expiry>.<m>.<signature>", m = 1 when the two-factor code was given. */
const makeSession = (mfa = false) => { const v = `${Date.now() + 12 * 3600e3}.${mfa ? 1 : 0}`; return `${v}.${sign(v)}`; };
const validSession = tok => {
  const [exp, m, sig] = String(tok || '').split('.');
  if (!sig || !/^[01]$/.test(m) || !safeEq(sig, sign(`${exp}.${m}`)) || !(Number(exp) > Date.now())) return null;
  return { mfa: m === '1' };
};
/** A session made without the code stops counting the moment two-factor is switched on for that account. */
const passwordSessionOk = req => { const s = validSession(cookies(req).lx_admin); return !!s && (s.mfa || !twofa.requiredFor([PASSWORD_SUBJECT])); };
const adminCookie = (req, mfa) => `lx_admin=${makeSession(mfa)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure(req)}`;
const userCookie = (req, user) => `lx_user=${signToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.round((user.exp - Date.now()) / 1000))}${secure(req)}`;
const TWOFA_RATE = (ip, who) => rateLimit('2fa-ip:' + ip, 10, 10 * 60e3) && rateLimit('2fa:' + who, 10, 10 * 60e3);

// --- tiny helpers --------------------------------------------------------
/**
 * The caller's address. Behind a proxy every hop APPENDS the address it saw to X-Forwarded-For, so the entries the
 * client could have forged are on the left; the trustworthy one is `PROXY_HOPS` places from the right.
 */
const clientIp = req => {
  const direct = req.socket.remoteAddress?.replace(/^::ffff:/, '') || '';
  if (!TRUST_PROXY) return direct;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  const ip = chain[Math.max(0, chain.length - PROXY_HOPS)];
  return (ip && ip.length <= 64 ? ip.replace(/^::ffff:/, '') : '') || direct;
};
/** The first X-Forwarded-Proto value, if it is something sane. */
const forwardedProto = req => { const v = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase(); return v === 'https' || v === 'http' ? v : ''; };
const isHttps = req => PUBLIC_URL.startsWith('https://') || forwardedProto(req) === 'https';
const secure = req => (isHttps(req) ? '; Secure' : '');
/** Cookies are attacker-controlled input: a malformed one must never turn into a 500 on every route. */
const cookies = req => {
  const out = {};
  for (const c of String(req.headers.cookie || '').split(/;\s*/)) {
    const i = c.indexOf('=');
    if (i < 1) continue;
    let v = c.slice(i + 1);
    try { v = decodeURIComponent(v); } catch { /* keep the raw value; it just won't verify */ }
    out[c.slice(0, i)] = v;
  }
  return out;
};
const buckets = new Map();
function rateLimit(id, max, windowMs) {
  const t = Date.now(), b = (buckets.get(id) || []).filter(x => t - x < windowMs);
  b.push(t); buckets.set(id, b);
  return b.length <= max;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of buckets) if (!v.some(x => t - x < 3600e3)) buckets.delete(k); }, 600e3).unref();

// Direct download links are public, so each one can only mint so many NEW licenses per hour (repeat downloads by the same buyer are free).
const MINT_PER_PRODUCT_HOUR = Math.max(1, Number(process.env.LICENSEX_MINT_PER_HOUR || fileConfig.mintPerHour || 60));
const MINT_PER_IP_HOUR = 10;
const recentCount = (id, windowMs) => { const t = Date.now(); return (buckets.get(id) || []).filter(x => t - x < windowMs).length; };

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
  req.lxRecheck?.();   // signed-in routes: the caller's access may have changed while the body was on its way
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
async function saveUpload(req, destPath, max = MAX_UPLOAD) {
  const tmp = destPath + '.tmp-' + randomBytes(4).toString('hex');
  const out = createWriteStream(tmp);
  let size = 0, failure = null;
  out.on('error', e => { failure = e; }); // a full or read-only disk must fail this request, not crash the process
  const check = () => { if (failure) throw new HttpError(500, `Could not write the upload to disk (${failure.code || failure.message})`); };
  try {
    for await (const c of req) {
      size += c.length;
      if (size > max) throw new HttpError(413, `File too large (max ${Math.round(max / 1048576)} MB)`);
      check();
      if (!out.write(c)) { await new Promise(r => { out.once('drain', r); out.once('error', r); }); check(); }
    }
    check();
    await new Promise(r => out.end(r));
    check();
    req.lxRecheck?.();
  } catch (e) { out.destroy(); try { rmSync(tmp, { force: true }); } catch {} throw e; }
  if (size === 0) { try { rmSync(tmp, { force: true }); } catch {} throw new HttpError(400, 'Empty upload'); }
  renameSync(tmp, destPath);
  return size;
}

// --- routes --------------------------------------------------------------
export const routes = []; // [method, regex, handler, {admin | perm | platform}] (exported so tests can check that every admin route is guarded)
const route = (method, path, handler, opts = {}) =>
  routes.push([method, new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, opts]);

// Plugin API ----------------------------------------------------------------
route('POST', '/api/v1/validate', async ctx => {
  if (!rateLimit('val:' + ctx.ip, 600, 60e3)) throw new HttpError(429, 'Too many requests');
  const b = await body(ctx.req);
  const r = core.validate({ key: b.key, instanceId: b.instanceId, name: b.name, port: b.port, version: b.version, ip: ctx.ip });
  return [r.ok ? 200 : 403, r];
});

// Server-computed feature: the plugin asks the server to produce a result it does NOT have locally. A stripped copy
// (license check removed) has no fallback, so the feature simply cannot run. This is the one protection that a
// "set the guards to false" crack cannot defeat, because the behaviour was never shipped in the jar. Demo: /xroll.
route('POST', '/api/v1/feature', async ctx => {
  if (!rateLimit('feat:' + ctx.ip, 600, 60e3)) throw new HttpError(429, 'Too many requests');
  const b = await body(ctx.req);
  const lic = core.q.licenseByKey.get(normalizeKey(b.key || ''));
  if (!lic || core.licenseState(lic) !== 'active') return [403, { ok: false, message: 'License is not valid.' }];
  const feature = str(b.feature, 40);
  if (feature === 'roll') {
    let sides = int(b.params, { min: 2, max: 1000, nullable: true }) ?? 6;
    const value = 1 + Math.floor(Math.random() * sides);
    // The displayed text is composed on the server, so it is not present in the jar to copy.
    const flavour = value === sides ? ' A perfect roll!' : value === 1 ? ' Ouch.' : '';
    return [200, { ok: true, value, sides, text: `You rolled ${value} (d${sides}).${flavour} — computed on XdevStudios' server.` }];
  }
  return [400, { ok: false, message: 'Unknown feature.' }];
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
  const sales = !w && secret.length >= 16 && safeEq(secret, planSalesSecret(db));   // the owner's secret for selling plans (never shown to staff)
  if (!w && !sales) { if (rateLimit('bbb-deny:' + ctx.ip, 5, 60e3)) core.log('system', 'bbb.denied', ctx.ip, 'bad secret'); return [403, 'Forbidden']; }
  const uid = str(b.user_id, 32).trim(), rid = str(b.resource_id, 32).trim();
  if (!/^\d+$/.test(uid)) return [400, 'Missing user_id'];
  if (sales) {                         // a plan resource hands out an access key (see plansales.js); a repeating plan gets a fresh key every period
    const plan = planForResource(db, rid);
    if (!plan) return [404, 'No plan is sold under that resource id'];
    const key = issuePlanKey({ db, plan, user: uid, ip: ctx.ip });
    return [200, key];
  }
  const gid = Number(core.getSetting('bbb_group_id', w.id)) || null;
  // when the developer told us which product this BuiltByBit resource is, the license is linked to it
  const linked = rid ? db.prepare('SELECT id FROM products WHERE workspace_id=? AND bbb_resource_id=?').get(w.id, rid) : null;
  const r = core.claim({ ws: w.id, user: uid, name: `BuiltByBit #${uid}`, product: `BuiltByBit resource ${rid || '?'}`, product_id: linked?.id ?? null, relink: true,
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
  const needCode = twofa.requiredFor([PASSWORD_SUBJECT]);
  if (needCode) {
    if (!b.code) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app.', '2FA_REQUIRED');
    if (!TWOFA_RATE(ctx.ip, PASSWORD_SUBJECT)) throw new HttpError(429, 'Too many codes tried. Wait a few minutes.');
    if (!twofa.check([PASSWORD_SUBJECT], b.code)) { core.log('admin', 'login.2fa-fail', ctx.ip); throw new HttpError(401, 'That code is not right (or was already used).', '2FA_WRONG'); }
  }
  core.log('admin', 'login', ctx.ip, needCode ? 'with two-factor code' : '');
  return [200, { ok: true }, { 'Set-Cookie': adminCookie(ctx.req, needCode) }];
});
const CLEAR_COOKIES = ['lx_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'lx_user=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', 'lx_2fa=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'];
route('POST', '/api/admin/logout', async () => [200, { ok: true }, { 'Set-Cookie': CLEAR_COOKIES }]);
route('GET', '/api/admin/me', async ctx => {
  const w = db.prepare('SELECT id, name, plan_key, suspended FROM workspaces WHERE id=?').get(ctx.wsId);
  const sc = ctx.access.scope;
  return [200, { ok: true, via: ctx.admin.via, role: ctx.admin.role, name: ctx.admin.name, email: ctx.admin.email || '',
    permissions: [...ctx.access.perms], limited: !!sc, products: sc ? [...sc] : null,
    member_role: ctx.admin.member?.role_name || (ctx.access.owner ? 'Owner' : ''),
    workspaces: ctx.admin.workspaces || null, can_build: canBuild(ctx.admin),
    workspace: { id: w.id, name: w.name, house: w.id === HOUSE, suspended: !!w.suspended, plan: ctx.admin.role === 'member' ? null : (({ key, name, max_products, max_licenses, interval, price_cents, currency }) => ({ key, name, max_products, max_licenses, interval, price_cents, currency }))(core.planOf(w.id)) } }];
}, { admin: true });

// Who is signed in with Google/Discord/GitHub, and are they an admin? (public: the site header uses it)
const adminEmailSet = () => new Set([...CONFIG_ADMIN_EMAILS, ...parseEmails(core.getSetting('admin_emails'))]);
const sessionUser = req => {
  const u = readToken(cookies(req).lx_user);
  // signed in without the code while one of their emails has two-factor on (e.g. switched on after this session began): not signed in
  return u && (u.mfa || !twofa.requiredFor(twofa.emailSubjects(u.emails))) ? u : null;
};
/** Signed in with Google/Discord/GitHub, still owing the two-factor code (5 minutes to give it). */
const pendingUser = req => readToken(cookies(req).lx_2fa);
const isAdminUser = u => !!u && Array.isArray(u.emails) && u.emails.some(e => adminEmailSet().has(e)); // checked on every request
const workspaceOfUser = u => {
  if (!u || !Array.isArray(u.emails) || !u.emails.length) return null;
  const marks = u.emails.map(() => '?').join(',');
  // someone whose several verified emails each own a workspace gets the one for the email they signed in with, then the oldest
  return db.prepare(`SELECT * FROM workspaces WHERE owner_email IN (${marks}) ORDER BY (owner_email = ?) DESC, id LIMIT 1`).get(...u.emails, u.email || '') || null;
};
/**
 * Who is calling the admin API?
 *  - platform: the site owner (admin password, or a verified email on the admin list). Can open any workspace.
 *  - tenant:   a customer whose verified email owns a workspace.
 *  - member:   somebody a workspace owner added to their team: a verified email on a member row, holding a role.
 * Tenants and members can only ever touch the workspace they are acting in; if they belong to several they pick one with
 * the X-Workspace header (default: the one they own, else the first they were added to).
 */
const adminIdentity = (req, url) => {
  if (passwordSessionOk(req)) return { via: 'password', role: 'platform', name: 'Admin password' };
  const u = sessionUser(req);
  if (!u) return null;
  if (isAdminUser(u)) return { via: u.p, role: 'platform', name: u.name, email: u.email };
  const slots = slotsFor(db, u.emails, u.email);
  if (!slots.length) return null;
  const asked = Number(req.headers['x-workspace'] || url?.searchParams.get('ws') || 0);
  const slot = slots.find(x => x.wsId === asked) || slots[0];
  return { via: u.p, role: slot.kind === 'owner' ? 'tenant' : 'member', name: u.name, email: u.email, wsId: slot.wsId, member: slot.member,
    workspaces: slots.map(x => ({ id: x.wsId, name: x.name, role: x.role })) };
};
/** Which workspace a request acts on. Tenants and members: the one they are in. Platform: the one they picked (default: the owner's). */
function resolveWorkspace(admin, req, url) {
  if (admin.role !== 'platform') return admin.wsId;
  const asked = Number(req.headers['x-workspace'] || url.searchParams.get('ws') || HOUSE);
  return Number.isInteger(asked) && db.prepare('SELECT 1 FROM workspaces WHERE id=?').get(asked) ? asked : HOUSE;
}
route('GET', '/api/auth/me', async ctx => {
  const u = sessionUser(ctx.req), w = workspaceOfUser(u);
  const memberships = u ? slotsFor(db, u.emails, u.email).filter(x => x.kind === 'member').map(x => ({ id: x.wsId, name: x.name, role: x.role })) : [];
  return [200, {
    user: u ? { name: u.name, email: u.email, avatar: u.avatar, provider: u.p, isAdmin: isAdminUser(u), workspace: w ? { id: w.id, name: w.name } : null, memberships } : null,
    providers: Object.keys(oauthConf).map(id => ({ id, label: PROVIDERS[id].label })),
    password_login: !DISABLE_PASSWORD_LOGIN,
    twofa_pending: !u && !!pendingUser(ctx.req),
  }];
});
route('POST', '/api/auth/logout', async () => [200, { ok: true }, { 'Set-Cookie': CLEAR_COOKIES }]);

// OAuth redirect flow: GET /auth/<provider>  ->  provider  ->  GET /auth/<provider>/callback
const NEXT_OK = new Set(['/', '/admin', '/dashboard', '/account', '/pricing', '/login', '/login/creator', '/login/buyer']);
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
    email: profile.email, emails: profile.emails.slice(0, 20), exp: Date.now() + 7 * 86400e3 };
  const target = pending.n && NEXT_OK.has(pending.n) ? pending.n : '/';
  if (twofa.requiredFor(twofa.emailSubjects(user.emails))) {
    // not signed in yet: the code comes first (/login/2fa)
    core.log('user', 'login.2fa-asked', `${provider}:${profile.email || profile.id}`);
    return redirect(res, '/login/2fa', [
      `lx_2fa=${signToken({ user, n: target, exp: Date.now() + 5 * 60e3 })}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${secure(req)}`,
      'lx_user=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', 'lx_oauth=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0']);
  }
  core.log('user', isAdminUser(user) ? 'login.admin' : 'login', `${provider}:${profile.email || profile.id}`);
  if (user.emails.length) db.prepare(`UPDATE members SET last_login = ? WHERE email IN (${user.emails.map(() => '?').join(',')})`).run(now(), ...user.emails);
  redirect(res, target, [userCookie(req, user), 'lx_oauth=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0']);
}

// Two-factor -----------------------------------------------------------------------------------------------------
// The second step of a Google/Discord/GitHub sign-in.
route('POST', '/api/auth/2fa', async ctx => {
  const p = pendingUser(ctx.req);
  if (!p?.user) throw new HttpError(401, 'The sign-in expired. Please sign in again.', '2FA_EXPIRED');
  const b = await body(ctx.req), subjects = twofa.emailSubjects(p.user.emails);
  if (!TWOFA_RATE(ctx.ip, subjects[0] || p.user.id)) throw new HttpError(429, 'Too many codes tried. Wait a few minutes.');
  const who = `${p.user.p}:${p.user.email || p.user.id}`;
  if (!twofa.check(subjects, b.code)) { core.log('user', 'login.2fa-fail', who); throw new HttpError(401, 'That code is not right (or was already used).', '2FA_WRONG'); }
  const user = { ...p.user, mfa: 1 };
  core.log('user', isAdminUser(user) ? 'login.admin' : 'login', who, 'with two-factor code');
  if (user.emails.length) db.prepare(`UPDATE members SET last_login = ? WHERE email IN (${user.emails.map(() => '?').join(',')})`).run(now(), ...user.emails);
  return [200, { ok: true, next: NEXT_OK.has(p.n) ? p.n : '/' }, { 'Set-Cookie': [userCookie(ctx.req, user), 'lx_2fa=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'] }];
});

// Turning it on and off for your own account (anyone who can open the dashboard: the owner, customers and their team).
const twofaSubject = ctx => {
  if (ctx.admin.via === 'password') return PASSWORD_SUBJECT;
  if (!ctx.admin.email) throw new HttpError(400, 'Your sign-in shared no verified email, so two-factor cannot be set up for it.');
  return subjectForEmail(ctx.admin.email);
};
/** After switching it on, the session in use is re-issued as "code given" (every other session is signed out). */
const refreshedSession = ctx => {
  if (ctx.admin.via === 'password') return adminCookie(ctx.req, true);
  const u = readToken(cookies(ctx.req).lx_user);
  return u ? userCookie(ctx.req, { ...u, mfa: 1 }) : null;
};
const ownCode = async (ctx, subject) => {
  const b = await body(ctx.req);
  if (!TWOFA_RATE(ctx.ip, subject)) throw new HttpError(429, 'Too many codes tried. Wait a few minutes.');
  return b;
};
route('GET', '/api/admin/2fa', async ctx => {
  const subject = twofaSubject(ctx);
  return [200, { ...twofa.status(subject), account: ctx.admin.via === 'password' ? 'the admin password' : ctx.admin.email }];
}, { admin: true, allowSuspended: true });
route('POST', '/api/admin/2fa/setup', async ctx => {
  const subject = twofaSubject(ctx);
  const secret = twofa.begin(subject);
  if (!secret) throw new HttpError(409, 'Two-factor sign-in is already on. Switch it off first to move it to another phone.');
  const issuer = core.getSetting('site_name') || 'LicenseX';
  return [200, { secret, uri: otpauthUri({ issuer, account: ctx.admin.via === 'password' ? 'admin' : ctx.admin.email, secret }) }];
}, { admin: true, allowSuspended: true });
route('POST', '/api/admin/2fa/enable', async ctx => {
  const subject = twofaSubject(ctx), b = await ownCode(ctx, subject);
  const codes = twofa.finish(subject, b.code);
  if (!codes) throw new HttpError(400, 'That code is not right. Check that the time on your phone is correct and try the newest code.', '2FA_WRONG');
  core.log(ctx.admin.email || 'admin', '2fa.enable', subject, '', ctx.admin.role === 'platform' ? HOUSE : ctx.wsId);
  const cookie = refreshedSession(ctx);
  return [200, { ok: true, recovery_codes: codes }, cookie ? { 'Set-Cookie': cookie } : {}];
}, { admin: true, allowSuspended: true });
route('POST', '/api/admin/2fa/disable', async ctx => {
  const subject = twofaSubject(ctx), b = await ownCode(ctx, subject);
  if (!twofa.status(subject).enabled) return [200, { ok: true }];
  if (!twofa.check([subject], b.code)) throw new HttpError(400, 'That code is not right (or was already used).', '2FA_WRONG');
  twofa.remove(subject);
  core.log(ctx.admin.email || 'admin', '2fa.disable', subject, '', ctx.admin.role === 'platform' ? HOUSE : ctx.wsId);
  return [200, { ok: true }];
}, { admin: true, allowSuspended: true });
route('POST', '/api/admin/2fa/recovery', async ctx => {
  const subject = twofaSubject(ctx), b = await ownCode(ctx, subject);
  if (!twofa.status(subject).enabled) throw new HttpError(409, 'Two-factor sign-in is off.');
  if (!twofa.check([subject], b.code)) throw new HttpError(400, 'That code is not right (or was already used).', '2FA_WRONG');
  core.log(ctx.admin.email || 'admin', '2fa.recovery', subject, 'new recovery codes', ctx.admin.role === 'platform' ? HOUSE : ctx.wsId);
  return [200, { recovery_codes: twofa.newRecovery(subject) }];
}, { admin: true, allowSuspended: true });
// The site owner can switch it off for someone who lost their phone and their recovery codes.
route('POST', '/api/admin/2fa/reset', async ctx => {
  const b = await body(ctx.req), who = normEmail(b.email);
  if (!EMAIL_RE.test(who)) throw new HttpError(400, 'Enter the email address of the account.');
  const done = twofa.remove(subjectForEmail(who));
  if (done) core.log(ctx.admin.email || 'admin', '2fa.reset', who, '', HOUSE);
  return [200, { ok: true, was_on: done }];
}, { platform: true });

// Admin: stats ----------------------------------------------------------------
route('GET', '/api/admin/stats', async ctx => {
  const w = ctx.wsId, t = now(), one = (sql, ...args) => db.prepare(sql).get(...args);
  const hb = Number(core.getSetting('heartbeat_minutes', w));
  const [ls, la] = scopeSql(ctx, 'l.product_id'), [ls2, la2] = scopeSql(ctx, 'product_id');
  const seeLicenses = can(ctx, 'licenses.view'), seeServers = can(ctx, 'servers.view');
  const out = { licenses: 0, blocked: 0, servers: 0, online: 0, disabled: 0, issued_24h: 0, per_day: [], recent: [], hidden: [] };
  if (seeLicenses) Object.assign(out, {
    licenses: one(`SELECT COUNT(*) n FROM licenses WHERE workspace_id=? AND ${ls2}`, w, ...la2).n,
    blocked: one(`SELECT COUNT(*) n FROM licenses WHERE workspace_id=? AND status='blocked' AND ${ls2}`, w, ...la2).n,
    issued_24h: one(`SELECT COUNT(*) n FROM licenses WHERE workspace_id=? AND created_at > ? AND ${ls2}`, w, t - 86400, ...la2).n,
    per_day: db.prepare(`SELECT date(created_at,'unixepoch') d, COUNT(*) n FROM licenses WHERE workspace_id=? AND created_at > ? AND ${ls2} GROUP BY d ORDER BY d`).all(w, t - 14 * 86400, ...la2),
  }); else out.hidden.push('licenses');
  if (seeServers) Object.assign(out, {
    servers: one(`SELECT COUNT(*) n FROM servers s JOIN licenses l ON l.id=s.license_id WHERE l.workspace_id=? AND s.status='active' AND ${ls}`, w, ...la).n,
    online: one(`SELECT COUNT(*) n FROM servers s JOIN licenses l ON l.id=s.license_id WHERE l.workspace_id=? AND s.status='active' AND s.last_seen > ? AND ${ls}`, w, t - 2 * hb * 60, ...la).n,
    disabled: one(`SELECT COUNT(*) n FROM servers s JOIN licenses l ON l.id=s.license_id WHERE l.workspace_id=? AND s.status='disabled' AND ${ls}`, w, ...la).n,
  }); else out.hidden.push('servers');
  if (can(ctx, 'audit.view')) out.recent = db.prepare('SELECT * FROM audit WHERE workspace_id=? ORDER BY id DESC LIMIT 8').all(w);
  return [200, out];
}, { admin: true });

// Admin: licenses -------------------------------------------------------------
// Everything below is scoped to ctx.wsId (the caller's own workspace). Looking a row up by id ALWAYS includes the workspace.
// A member limited to some products (ctx.access.scope) only ever sees licenses, servers and products linked to those; to them anything else does not exist.
const inScope = (ctx, productId) => !ctx.access?.scope || (productId != null && ctx.access.scope.has(productId));
/** SQL for "only my products": [fragment, args] to AND into a query over a table/alias that has the product_id column. */
const scopeSql = (ctx, col) => {
  const sc = ctx.access?.scope;
  if (!sc) return ['1=1', []];
  return sc.size ? [`${col} IN (${[...sc].map(() => '?').join(',')})`, [...sc]] : ['0', []];
};
const can = (ctx, perm) => !!ctx.access?.perms.has(perm);
const need = (ctx, perm) => { if (!can(ctx, perm)) throw new HttpError(403, 'You do not have permission to do that.', 'FORBIDDEN'); };
const ownLicense = (ctx, id) => { const l = db.prepare('SELECT * FROM licenses WHERE id=? AND workspace_id=?').get(id, ctx.wsId); if (!l || !inScope(ctx, l.product_id)) throw new HttpError(404, 'Not found'); return l; };
const ownProduct = (ctx, id) => { const p = db.prepare('SELECT * FROM products WHERE id=? AND workspace_id=?').get(id, ctx.wsId); if (!p || !inScope(ctx, p.id)) throw new HttpError(404, 'Not found'); return p; };
/** A product id from a request body: it must exist in this workspace and, for a limited member, be one of theirs. */
const ownProductId = (ctx, v) => {
  const id = int(v, { min: 1, nullable: true });
  if (id == null) { if (ctx.access?.scope) throw new HttpError(400, 'Pick one of your products.'); return null; }
  const p = db.prepare('SELECT id FROM products WHERE id=? AND workspace_id=?').get(id, ctx.wsId);
  if (!p || !inScope(ctx, p.id)) throw new HttpError(400, 'Unknown product');
  return p.id;
};
const ownGroup = (ctx, gid) => { if (gid == null) return null; if (!db.prepare('SELECT 1 FROM license_groups WHERE id=? AND workspace_id=?').get(gid, ctx.wsId)) throw new HttpError(400, 'Unknown group'); return gid; };
const wl = (ctx, action, target = '', detail = '') => core.log(ctx.admin?.email || 'admin', action, target, detail, ctx.wsId);
const withinPlan = fn => { try { return fn(); } catch (e) { if (e instanceof PlanError) throw new HttpError(402, e.message, e.code); throw e; } };
const licenseRow = l => ({ ...l, state: core.licenseState(l), limit: core.effectiveLimit(l), used: core.usedSlots(l) });
route('GET', '/api/admin/licenses', async ctx => {
  const u = ctx.url.searchParams, where = ['l.workspace_id = ?'], args = [ctx.wsId];
  const [sw, sa] = scopeSql(ctx, 'l.product_id'); where.push(sw); args.push(...sa);
  const text = u.get('q')?.trim();
  if (text) { where.push('(l.key LIKE ? OR l.owner LIKE ? OR l.note LIKE ? OR l.issued_ip LIKE ? OR l.issued_device LIKE ? OR l.buyer_email LIKE ?)'); args.push(...Array(6).fill(`%${text}%`)); }
  if (u.get('status') === 'blocked') where.push("l.status='blocked'");
  if (u.get('status') === 'active') where.push("l.status='active'");
  if (u.get('group')) { where.push('l.group_id = ?'); args.push(Number(u.get('group'))); }
  if (u.get('product') === 'none') where.push('l.product_id IS NULL');
  else if (u.get('product')) { where.push('l.product_id = ?'); args.push(Number(u.get('product'))); }
  if (u.get('ip')) { where.push('l.issued_ip = ?'); args.push(u.get('ip')); }
  const rows = db.prepare(`SELECT l.*, p.name product_name FROM licenses l LEFT JOIN products p ON p.id = l.product_id WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT 500`).all(...args);
  return [200, rows.map(licenseRow)];
}, { perm: 'licenses.view' });
route('GET', '/api/admin/licenses/:id', async ctx => {
  const lic = ownLicense(ctx, ctx.params.id);
  const same_ip = lic.issued_ip ? db.prepare(`SELECT id,key,owner,created_at FROM licenses l WHERE l.workspace_id = ? AND l.issued_ip = ? AND l.id != ? AND ${scopeSql(ctx, 'l.product_id')[0]} ORDER BY l.id DESC LIMIT 20`)
    .all(ctx.wsId, lic.issued_ip, lic.id, ...scopeSql(ctx, 'l.product_id')[1]) : [];
  const product_name = lic.product_id ? db.prepare('SELECT name FROM products WHERE id=?').get(lic.product_id)?.name || '' : '';
  const servers = can(ctx, 'servers.view') ? db.prepare('SELECT * FROM servers WHERE license_id = ? ORDER BY first_seen').all(lic.id) : [];
  return [200, { ...licenseRow({ ...lic, product_name }), servers, same_ip }];
}, { perm: 'licenses.view' });

const LICENSE_EDIT_FIELDS = ['owner', 'note', 'group_id', 'max_servers', 'expires_at', 'buyer_email', 'product_id'];
function licenseFields(ctx, b, partial) {
  const f = {};
  if (!partial || 'owner' in b) f.owner = str(b.owner, 64);
  if (!partial || 'note' in b) f.note = str(b.note, 500);
  if (!partial || 'group_id' in b) {
    f.group_id = ownGroup(ctx, int(b.group_id, { min: 1, nullable: true }));
  }
  if (!partial || 'max_servers' in b) f.max_servers = int(b.max_servers, { min: -1, max: 100000, nullable: true });
  if (!partial || 'expires_at' in b) f.expires_at = int(b.expires_at, { min: 1, max: 4e10, nullable: true });
  if (!partial || 'buyer_email' in b) {
    const e = normEmail(b.buyer_email);
    if (e && (e.length > 120 || !EMAIL_RE.test(e))) throw new HttpError(400, 'The buyer email is not a valid address.');
    f.buyer_email = e;
  }
  if (!partial || 'product_id' in b) {
    f.product_id = ownProductId(ctx, b.product_id);
    f.product = f.product_id ? db.prepare('SELECT name FROM products WHERE id=?').get(f.product_id).name : '';
  }
  if ('status' in b) { if (!['active', 'blocked'].includes(b.status)) throw new HttpError(400, 'Bad status'); f.status = b.status; }
  if ('block_reason' in b) f.block_reason = str(b.block_reason, 200);
  return f;
}
route('POST', '/api/admin/licenses', async ctx => {
  const b = await body(ctx.req);
  const lic = withinPlan(() => core.createLicense({ ...licenseFields(ctx, b, false), workspace_id: ctx.wsId }));
  wl(ctx, 'license.create', lic.key, lic.owner);
  return [201, licenseRow(lic)];
}, { perm: 'licenses.create' });
route('PATCH', '/api/admin/licenses/:id', async ctx => {
  const lic = ownLicense(ctx, ctx.params.id);
  const f = licenseFields(ctx, await body(ctx.req), true);
  // changing the details and blocking are separate permissions
  if (LICENSE_EDIT_FIELDS.some(k => k in f)) need(ctx, 'licenses.edit');
  if ('status' in f || 'block_reason' in f) need(ctx, 'licenses.block');
  if (f.status === 'active') f.block_reason = '';
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE licenses SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => f[k]), lic.id);
  wl(ctx, f.status ? (f.status === 'blocked' ? 'license.block' : 'license.unblock') : 'license.update', lic.key, JSON.stringify(f));
  return [200, licenseRow(core.q.licenseById.get(lic.id))];
}, { perm: ['licenses.edit', 'licenses.block'] });
route('DELETE', '/api/admin/licenses/:id', async ctx => {
  const lic = ownLicense(ctx, ctx.params.id);
  db.prepare('DELETE FROM licenses WHERE id=?').run(lic.id);
  wl(ctx, 'license.delete', lic.key, lic.owner);
  return [200, { ok: true }];
}, { perm: 'licenses.delete' });

// Leak tracer: upload a leaked jar, find out whose copy it was. -----------------------------------------------------
const MARK_RE = /^[0-9a-f]{16}$/;
/** What a jar says about where it came from: the license key and the download marks stamped into it. */
function jarClues(jar) {
  try { listEntries(jar); } catch { throw new HttpError(400, 'That file is not a .jar (or it is damaged).'); }
  let cfg = null;
  try { cfg = readWrappedConfig(jar, SESSION_SECRET); } catch { cfg = null; }
  const key = cfg && typeof cfg.key === 'string' ? normalizeKey(cfg.key) : '';
  let comment = ''; try { comment = readZipComment(jar).trim(); } catch {}
  const marks = [...new Set([cfg?.mark, comment].filter(m => typeof m === 'string' && MARK_RE.test(m)))];
  return { has_config: !!cfg, key: KEY_RE.test(key) ? key : '', marks, product: cfg && typeof cfg.product === 'string' ? cfg.product.slice(0, 80) : '' };
}
route('POST', '/api/admin/leaks/trace', async ctx => {
  if (!rateLimit('trace:' + ctx.ip, 30, 60e3)) throw new HttpError(429, 'Too many files at once. Wait a minute.');
  const tmp = join(DATA, `trace-${randomBytes(6).toString('hex')}.jar`);
  let jar;
  try { await saveUpload(ctx.req, tmp); jar = readFileSync(tmp); } finally { rmSync(tmp, { force: true }); }
  const clues = jarClues(jar);
  const [sw, sa] = scopeSql(ctx, 'd.product_id');
  const dls = clues.marks.length ? db.prepare(`SELECT d.*, p.name product_name FROM downloads d LEFT JOIN products p ON p.id = d.product_id
    WHERE d.workspace_id = ? AND d.mark IN (${clues.marks.map(() => '?').join(',')}) AND ${sw}`).all(ctx.wsId, ...clues.marks, ...sa) : [];
  const download = dls[0] || null;
  const visible = l => (l && l.workspace_id === ctx.wsId && inScope(ctx, l.product_id) ? l : null);
  const byKey = clues.key ? visible(db.prepare('SELECT * FROM licenses WHERE key = ?').get(clues.key)) : null;
  const byMark = download ? visible(db.prepare('SELECT * FROM licenses WHERE id = ?').get(download.license_id) || db.prepare('SELECT * FROM licenses WHERE key = ?').get(download.license_key)) : null;
  // The mark says which download the file is; the key says which license it runs on. Leakers sometimes put in another key.
  const verdict = byMark && byKey ? (byMark.id === byKey.id ? 'match' : 'key_swapped') : byMark ? 'mark_only' : byKey ? 'key_only' : download ? 'license_deleted' : 'none';
  const describe = l => {
    if (!l) return null;
    const product_name = l.product_id ? db.prepare('SELECT name FROM products WHERE id=?').get(l.product_id)?.name || l.product : l.product;
    return { ...licenseRow({ ...l, product_name }),
      servers: can(ctx, 'servers.view') ? db.prepare('SELECT name, ip, port, version, status, first_seen, last_seen FROM servers WHERE license_id = ? ORDER BY last_seen DESC LIMIT 20').all(l.id) : [],
      downloads: db.prepare('SELECT at, ip, user_agent FROM downloads WHERE license_id = ? ORDER BY at DESC LIMIT 20').all(l.id) };
  };
  wl(ctx, 'leak.trace', (byMark || byKey)?.key || '', verdict);
  return [200, { verdict, file: { has_config: clues.has_config, key: clues.key, marks: clues.marks, product: clues.product },
    download: download && { at: download.at, ip: download.ip, user_agent: download.user_agent, bbb_user: download.bbb_user, product: download.product_name || '', license_key: download.license_key },
    license: describe(byMark || byKey), other_license: verdict === 'key_swapped' ? describe(byKey) : null }];
}, { perm: 'licenses.view' });

// Delete licenses that downloads issued but that were never used on a server: the quick way to clear out junk.
route('POST', '/api/admin/licenses/purge-unused', async ctx => {
  const b = await body(ctx.req);
  const days = int(b.older_than_days ?? 7, { min: 0, max: 3650 });
  const cutoff = core.now() - days * 86400;
  const [sw, sa] = scopeSql(ctx, 'product_id');
  const where = `workspace_id = ? AND source = 'claim' AND status = 'active' AND created_at <= ? AND ${sw} AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.license_id = licenses.id)`;
  const count = db.prepare(`SELECT COUNT(*) n FROM licenses WHERE ${where}`).get(ctx.wsId, cutoff, ...sa).n;
  if (!b.dry_run && count) {
    db.prepare(`DELETE FROM licenses WHERE ${where}`).run(ctx.wsId, cutoff, ...sa);
    wl(ctx, 'license.purge', '', `${count} unused download license(s) older than ${days} day(s)`);
  }
  return [200, { ok: true, count, deleted: !b.dry_run }];
}, { perm: 'licenses.delete' });

// Admin: servers --------------------------------------------------------------
route('GET', '/api/admin/servers', async ctx => {
  const text = ctx.url.searchParams.get('q')?.trim();
  const [sw, sa] = scopeSql(ctx, 'l.product_id');
  // a license key is a credential: it is only shown (and searchable) to people who may see licenses
  const withKeys = can(ctx, 'licenses.view');
  const rows = db.prepare(`SELECT s.*, l.key license_key, l.owner FROM servers s JOIN licenses l ON l.id = s.license_id
    WHERE l.workspace_id = ? AND ${sw} AND s.status != 'removed' ${text ? (withKeys ? 'AND (s.name LIKE ? OR s.ip LIKE ? OR l.key LIKE ? OR l.owner LIKE ?)' : 'AND (s.name LIKE ? OR s.ip LIKE ?)') : ''} ORDER BY s.last_seen DESC LIMIT 500`)
    .all(ctx.wsId, ...sa, ...(text ? Array(withKeys ? 4 : 2).fill(`%${text}%`) : []));
  return [200, withKeys ? rows : rows.map(r => ({ ...r, license_key: '', owner: '' }))];
}, { perm: 'servers.view' });
/** A server of this workspace that the caller may touch (for a limited member: only on licenses of their products). */
const ownServer = (ctx, id) => {
  const s = db.prepare('SELECT s.*, l.key k, l.product_id FROM servers s JOIN licenses l ON l.id=s.license_id WHERE s.id=? AND l.workspace_id=?').get(id, ctx.wsId);
  if (!s || !inScope(ctx, s.product_id)) throw new HttpError(404, 'Not found');
  return s;
};
route('PATCH', '/api/admin/servers/:id', async ctx => {
  const b = await body(ctx.req);
  if (!['active', 'disabled'].includes(b.status)) throw new HttpError(400, 'Bad status');
  const s = ownServer(ctx, ctx.params.id);
  db.prepare('UPDATE servers SET status=? WHERE id=?').run(b.status, s.id);
  wl(ctx, b.status === 'disabled' ? 'server.disable' : 'server.enable', s.k, `${s.ip}:${s.port} ${s.name}`);
  return [200, { ok: true }];
}, { perm: 'servers.manage' });
route('DELETE', '/api/admin/servers/:id', async ctx => {
  const s = ownServer(ctx, ctx.params.id);
  db.prepare("UPDATE servers SET status='removed' WHERE id=?").run(s.id); // plugin learns about it on next heartbeat
  wl(ctx, 'server.remove', s.k, `${s.ip}:${s.port} ${s.name}`);
  return [200, { ok: true }];
}, { perm: 'servers.manage' });

// Admin: products (plugin downloads) ------------------------------------------
const productFile = slug => join(PRODUCTS_DIR, slug + '.bin');
/** A free product slug. Slugs are at most 48 characters, suffix included: download addresses and backup file names rely on it. */
function uniqueSlug(wanted) {
  const base = slugify(wanted);
  let slug = base;
  for (let i = 2; db.prepare('SELECT 1 FROM products WHERE slug=?').get(slug); i++) {
    const suffix = `-${i}`;
    slug = base.slice(0, 48 - suffix.length).replace(/-+$/, '') + suffix;
  }
  return slug;
}
/**
 * The address buyers and OAuth providers should use for this server. Set LICENSEX_PUBLIC_URL: without it we have to
 * guess from the request, and the Host header is whatever the caller typed (only a plain host[:port] is accepted).
 */
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
const publicBase = req => {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = String(req.headers.host || '');
  return `${(TRUST_PROXY && forwardedProto(req)) || 'http'}://${HOST_RE.test(host) ? host : 'localhost:' + PORT}`;
};
const downloadUrlFor = (req, p) => `${publicBase(req)}/download/${p.slug}?token=${p.token}`;
const productRow = (req, p) => {
  const { wrap_ok, wrap_code, wrap_message, main_class, ...rest } = p;
  return { ...rest, download_url: downloadUrlFor(req, p),
    integration: !p.has_file ? null : { ok: !!wrap_ok, integrated: wrap_code === 'ALREADY_INTEGRATED', code: wrap_code, message: wrap_message, main: main_class } };
};
// --- the prototype ------------------------------------------------------------------
// Every account gets one small ready-made plugin (XHello, source in prototype/xhello) as a product of its own. It works
// like any product (licenses, downloads, BuiltByBit) but does not count toward the plan, and its file cannot be swapped.
const PROTOTYPE_JAR = join(ROOT, 'server', 'prototype', 'XHello.jar'), PROTOTYPE_FILE = 'XHello-1.3.0.jar';
function notPrototype(p, why = 'Its file is provided by us and cannot be replaced.') {
  if (p.prototype) throw new HttpError(400, `"${p.name}" is the free prototype. ${why}`);
  return p;
}
function ensurePrototype(wsId) {
  if (!existsSync(PROTOTYPE_JAR)) return;
  let p = db.prepare('SELECT * FROM products WHERE workspace_id = ? AND prototype = 1').get(wsId);
  if (!p) {
    const r = db.prepare('INSERT INTO products(workspace_id,slug,name,token,prototype,created_at) VALUES(?,?,?,?,1,?)').run(wsId, uniqueSlug('xhello'), 'XHello (prototype)', randomBytes(12).toString('base64url'), now());
    p = db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid);
  }
  // new accounts, and existing ones whenever we ship a new version of the prototype
  if (p.filename !== PROTOTYPE_FILE || !existsSync(productFile(p.slug))) setProductFile({ wsId, admin: { email: 'system' } }, p, readFileSync(PROTOTYPE_JAR), PROTOTYPE_FILE);
}
route('GET', '/api/admin/products', async ctx => {
  ensurePrototype(ctx.wsId);
  const [sw, sa] = scopeSql(ctx, 'p.id');
  const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM licenses l WHERE l.product_id = p.id) licenses FROM products p WHERE p.workspace_id=? AND ${sw} ORDER BY p.id DESC`).all(ctx.wsId, ...sa);
  return [200, rows.map(p => productRow(ctx.req, can(ctx, 'licenses.view') ? p : { ...p, licenses: null }))];
}, { perm: 'products.view' });
// Names of the products the caller may link a license to (a limited member only gets theirs).
route('GET', '/api/admin/products/options', async ctx => {
  const [sw, sa] = scopeSql(ctx, 'id');
  return [200, db.prepare(`SELECT id, name FROM products WHERE workspace_id=? AND ${sw} ORDER BY name`).all(ctx.wsId, ...sa)];
}, { perm: ['licenses.create', 'licenses.edit', 'products.view'] });
route('POST', '/api/admin/products', async ctx => {
  const b = await body(ctx.req);
  const name = str(b.name, 60).trim();
  if (!name) throw new HttpError(400, 'Name required');
  const group_id = ownGroup(ctx, b.group_id ? int(b.group_id, { min: 1 }) : null);
  withinPlan(() => core.assertWithin(ctx.wsId, 'products'));
  const slug = uniqueSlug(b.slug || name);
  const r = db.prepare('INSERT INTO products(workspace_id,slug,name,token,group_id,created_at) VALUES(?,?,?,?,?,?)').run(ctx.wsId, slug, name, randomBytes(12).toString('base64url'), group_id, now());
  wl(ctx, 'product.create', slug, name);
  return [201, productRow(ctx.req, db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid))];
}, { perm: 'products.create' });
/** Stores `buf` as the plugin file of product `p` and records whether it can be wrapped. */
function setProductFile(ctx, p, buf, filename) {
  try { injectFiles(buf, [{ name: '.licensex-probe', content: '1' }]); }
  catch { throw new HttpError(400, 'That file is not a valid .jar/.zip archive.'); }
  const w = checkWrappable(buf);
  const tmp = productFile(p.slug) + '.new-' + randomBytes(4).toString('hex');
  writeFileSync(tmp, buf);
  renameSync(tmp, productFile(p.slug));
  db.prepare('UPDATE products SET filename=?, size=?, has_file=1, wrap_ok=?, wrap_code=?, wrap_message=?, main_class=? WHERE id=?')
    .run(filename, buf.length, w.ok ? 1 : 0, w.code, w.message, w.main || '', p.id);
  wl(ctx, 'product.upload', p.slug, `${filename} ${buf.length}B ${w.ok ? 'integrated:' + w.main : w.code}`);
}
// Raw binary upload (the plugin jar). Streamed to a temp file and only swapped in once it checks out, so a bad
// upload can never replace (or delete) the jar that buyers are currently downloading.
route('POST', '/api/admin/products/:id/file', async ctx => {
  const p = notPrototype(ownProduct(ctx, ctx.params.id));
  const filename = str(ctx.req.headers['x-filename'] || 'plugin.jar', 80);
  const tmp = join(DATA, '.product-upload-' + randomBytes(4).toString('hex'));
  try {
    await saveUpload(ctx.req, tmp);
    setProductFile(ctx, p, readFileSync(tmp), filename);
  } finally { rmSync(tmp, { force: true }); }
  return [200, productRow(ctx.req, db.prepare('SELECT * FROM products WHERE id=?').get(p.id))];
}, { perm: 'products.edit' });
// The jar to upload to BuiltByBit: wrapped, but with no key. BuiltByBit overwrites %%__BBB_LICENSE__%% per buyer.
route('GET', '/api/admin/products/:id/bbb-build', async ctx => {
  const p = ownProduct(ctx, ctx.params.id);
  if (!p.has_file) throw new HttpError(404, 'Upload a plugin file first.');
  const stem = (p.filename || p.slug + '.jar').replace(/\.(jar|zip)$/i, '').replace(/[^\w.\-]/g, '_');
  return [200, licensedJar(ctx.req, p, ''), { 'Content-Type': 'application/java-archive', 'Content-Disposition': `attachment; filename="${stem}-builtbybit.jar"` }];
}, { perm: 'products.edit' });
route('PATCH', '/api/admin/products/:id', async ctx => {
  const p = ownProduct(ctx, ctx.params.id);
  const b = await body(ctx.req), f = {};
  if ('name' in b) { f.name = str(b.name, 60).trim(); if (!f.name) throw new HttpError(400, 'Name required'); }
  if ('enabled' in b) f.enabled = b.enabled ? 1 : 0;
  if ('group_id' in b) f.group_id = ownGroup(ctx, b.group_id ? int(b.group_id, { min: 1 }) : null);
  if (b.regenerate_token) f.token = randomBytes(12).toString('base64url');
  if ('bbb_resource_id' in b) {
    // linking a resource re-links licenses across the whole workspace and reveals which ids other products use, so it is not for people limited to some products
    if (ctx.access.scope) throw new HttpError(403, 'Only people with access to all products can link a BuiltByBit resource.', 'FORBIDDEN');
    // which BuiltByBit resource this product is, so licenses BuiltByBit asks for are linked to it (and to the people limited to it)
    const rid = str(b.bbb_resource_id, 12).trim();
    if (rid && !/^\d{1,12}$/.test(rid)) throw new HttpError(400, 'The BuiltByBit resource id is the number in the resource\'s address.');
    if (rid && db.prepare('SELECT 1 FROM products WHERE workspace_id=? AND bbb_resource_id=? AND id!=?').get(ctx.wsId, rid, p.id)) throw new HttpError(409, 'Another product already uses that BuiltByBit resource id.');
    f.bbb_resource_id = rid;
  }
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE products SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => f[k]), p.id);
  if (f.bbb_resource_id) db.prepare('UPDATE licenses SET product_id = ? WHERE workspace_id = ? AND product_id IS NULL AND product = ?').run(p.id, ctx.wsId, `BuiltByBit resource ${f.bbb_resource_id}`);
  wl(ctx, 'product.update', p.slug, JSON.stringify(f).replace(/"token":"[^"]+"/, '"token":"***"'));
  return [200, productRow(ctx.req, db.prepare('SELECT * FROM products WHERE id=?').get(p.id))];
}, { perm: 'products.edit' });
route('DELETE', '/api/admin/products/:id', async ctx => {
  const p = notPrototype(ownProduct(ctx, ctx.params.id), 'It is included with every account. Use Disable to switch it off.');
  rmSync(productFile(p.slug), { force: true });
  db.prepare('UPDATE licenses SET product_id = NULL WHERE product_id = ?').run(p.id); // keep the licenses, just unlinked
  db.prepare('DELETE FROM products WHERE id=?').run(p.id);
  wl(ctx, 'product.delete', p.slug, p.name);
  return [200, { ok: true }];
}, { perm: 'products.delete' });

// Admin: build from source ---------------------------------------------------------
// Upload a Maven/Gradle project as a zip -> inspection report -> build -> jar (optionally straight into a product).
// See docs/BUILD.md for what this does and does not protect against.
// Customers (not just the site owner) may use it when LICENSEX_CUSTOMER_BUILDS=1. Off by default: a build can run its
// own code on this server, so only switch it on when every customer is someone you trust (docs/BUILD.md).
const CUSTOMER_BUILDS = process.env.LICENSEX_CUSTOMER_BUILDS === '1' || fileConfig.customerBuilds === true;
const canBuild = admin => admin?.role === 'platform' || CUSTOMER_BUILDS;
// Puts a jar into a product: the chosen existing product, or a new one with that name. Returns the product.
function jarToProduct(ctx, target, buf, filename) {
  let p;
  if (target.productId) p = notPrototype(ownProduct(ctx, target.productId));
  else {
    withinPlan(() => core.assertWithin(ctx.wsId, 'products'));
    const slug = uniqueSlug(target.name);
    const r = db.prepare('INSERT INTO products(workspace_id,slug,name,token,created_at) VALUES(?,?,?,?,?)').run(ctx.wsId, slug, target.name, randomBytes(12).toString('base64url'), now());
    p = db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid);
    wl(ctx, 'product.create', slug, target.name);
  }
  setProductFile(ctx, p, buf, filename);
  return p;
}
// Which product a request asks for: { productId } or { name }. Checked against the caller's rights.
function buildTarget(ctx, b, fallbackName) {
  if (b.productId) return { productId: notPrototype(ownProduct(ctx, int(b.productId, { min: 1 }))).id };
  if (!ctx.access.perms.has('products.create')) throw new HttpError(403, 'You may not create products. Pick an existing product.');
  const name = str(b.name || fallbackName || '', 60).trim();
  if (!name) throw new HttpError(400, 'Give the new product a name, or pick an existing product.');
  return { name };
}
const builds = createBuildService({ baseDir: join(DATA, 'builds'), onDone: j => {
  // Built: put it straight into the product picked when the build started.
  if (!j.auto) return;
  const a = j.auto, ctx = { wsId: a.wsId, admin: { email: a.email }, access: { scope: a.scope ? new Set(a.scope) : null } };
  const p = jarToProduct(ctx, a, readFileSync(j.jar.path), j.jar.name);
  j.auto = { ...a, productId: p.id, done: p.name };
} });
setInterval(() => builds.sweep(), 3600e3).unref();
const asHttp = fn => { try { return fn(); } catch (e) { if (e instanceof BuildError) throw new HttpError(e.status, e.message); throw e; } };
const buildOpts = { perm: 'products.edit', build: true };
const ownJob = ctx => { const j = builds.get(ctx.params.id, ctx.wsId); if (!j) throw new HttpError(404, 'Build not found'); return j; };
route('GET', '/api/admin/builds/tools', async () => [200, builds.tools()], buildOpts);
route('GET', '/api/admin/builds', async ctx => [200, builds.list(ctx.wsId)], buildOpts);
route('POST', '/api/admin/builds', async ctx => {
  const tmp = join(DATA, '.build-upload-' + randomBytes(4).toString('hex'));
  const filename = str(ctx.req.headers['x-filename'] || 'source.zip', 80);
  try {
    await saveUpload(ctx.req, tmp);
    const job = asHttp(() => builds.create(readFileSync(tmp), filename, ctx.wsId));
    wl(ctx, 'build.upload', job.id, `${filename} ${job.report.kind} findings=${job.report.findings.length}`);
    return [201, job];
  } finally { rmSync(tmp, { force: true }); }
}, buildOpts);
route('GET', '/api/admin/builds/:id', async ctx => [200, ownJob(ctx)], buildOpts);
// Starts the build. Unless { product: false }, the jar is added to a product automatically once it is built:
// { productId } replaces that product's file, otherwise a new product is made (named { name } or after the plugin).
route('POST', '/api/admin/builds/:id/build', async ctx => {
  const b = await body(ctx.req), j0 = ownJob(ctx);
  const target = b.product === false ? null : buildTarget(ctx, b, j0.report?.plugin?.name || j0.filename.replace(/\.zip$/i, ''));
  if (target?.name) withinPlan(() => core.assertWithin(ctx.wsId, 'products'));
  const auto = target && { ...target, wsId: ctx.wsId, email: ctx.admin.email || 'admin', scope: ctx.access.scope ? [...ctx.access.scope] : null };
  const job = asHttp(() => builds.start(ctx.params.id, { trust: b.trust === true, auto }));
  wl(ctx, 'build.start', job.id, `${job.filename} trusted=${job.trusted}`);
  return [202, job];
}, buildOpts);
route('GET', '/api/admin/builds/:id/jar', async ctx => {
  ownJob(ctx);
  const f = builds.jarFile(ctx.params.id);
  if (!f) throw new HttpError(404, 'No jar for this build');
  return [200, readFileSync(f.path), { 'Content-Type': 'application/java-archive', 'Content-Disposition': `attachment; filename="${f.name.replace(/[^\w.\-]/g, '_')}"` }];
}, buildOpts);
// Put the built jar into a product by hand: replace an existing product's file, or create a new product from it.
route('POST', '/api/admin/builds/:id/product', async ctx => {
  const b = await body(ctx.req);
  ownJob(ctx);
  const f = builds.jarFile(ctx.params.id);
  if (!f) throw new HttpError(404, 'No jar for this build');
  const p = jarToProduct(ctx, buildTarget(ctx, b), readFileSync(f.path), f.name);
  return [200, productRow(ctx.req, db.prepare('SELECT * FROM products WHERE id=?').get(p.id))];
}, buildOpts);
route('DELETE', '/api/admin/builds/:id', async ctx => { ownJob(ctx); asHttp(() => builds.remove(ctx.params.id)); return [200, { ok: true }]; }, buildOpts);

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
  await saveUpload(ctx.req, tmp, MAX_UPLOAD * 4); // a backup holds every plugin jar plus the database
  try {
    let file = readFileSync(tmp);
    if (isEncrypted(file)) { try { file = decrypt(file, OFFSITE.password); } catch (e) { throw new RestoreError(e.message); } }
    const r = restoreBackup(db, PRODUCTS_DIR, file, DatabaseSync);
    core.log('admin', 'backup.restore', '', `${r.products} plugin file(s)`);
    return [200, { ok: true, ...r }];
  } catch (e) {
    if (e instanceof RestoreError) throw new HttpError(400, e.message);
    throw e;
  } finally { rmSync(tmp, { force: true }); }
}, { platform: true });

route('GET', '/api/admin/offsite', async () => [200, { ...offsite.status(), blocked: !!OFFSITE.blocked }], { platform: true });
route('POST', '/api/admin/offsite/run', async ctx => {
  OFFSITE.blocked = false;   // the owner looked and wants copies sent again
  offsite.start();
  const r = await offsite.run({ force: true, reason: 'by hand' });
  core.log(ctx.admin.email || 'admin', 'backup.offsite', '', JSON.stringify(r.results || r.message), HOUSE);
  return [r.ok ? 200 : 502, r.ok ? r : { ok: false, message: r.message || Object.entries(r.results).map(([k, v]) => `${k}: ${v}`).join('; '), ...r }];
}, { platform: true });

// Admin: groups ---------------------------------------------------------------
const groupFields = b => {
  const name = str(b.name, 40).trim();
  if (!name) throw new HttpError(400, 'Name required');
  const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#8b5cf6';
  return [name, int(b.max_servers, { min: -1, max: 100000 }), color];
};
route('GET', '/api/admin/groups', async ctx => {
  const [sw, sa] = scopeSql(ctx, 'l.product_id');
  const rows = db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM licenses l WHERE l.group_id=g.id AND ${sw}) licenses FROM license_groups g WHERE g.workspace_id=? ORDER BY g.id`).all(...sa, ctx.wsId);
  return [200, can(ctx, 'licenses.view') ? rows : rows.map(g => ({ ...g, licenses: null }))];
}, { perm: 'groups.view' });
route('POST', '/api/admin/groups', async ctx => {
  const [name, max, color] = groupFields(await body(ctx.req));
  try { db.prepare('INSERT INTO license_groups(workspace_id,name,max_servers,color,created_at) VALUES(?,?,?,?,?)').run(ctx.wsId, name, max, color, now()); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A group with that name exists'); throw e; }
  wl(ctx, 'group.create', name, `limit=${max}`);
  return [201, { ok: true }];
}, { perm: 'groups.manage' });
route('PATCH', '/api/admin/groups/:id', async ctx => {
  const [name, max, color] = groupFields(await body(ctx.req));
  let r;
  try { r = db.prepare('UPDATE license_groups SET name=?, max_servers=?, color=? WHERE id=? AND workspace_id=?').run(name, max, color, ctx.params.id, ctx.wsId); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A group with that name exists'); throw e; }
  if (!r.changes) throw new HttpError(404, 'Not found');
  wl(ctx, 'group.update', name, `limit=${max}`);
  return [200, { ok: true }];
}, { perm: 'groups.manage' });
route('DELETE', '/api/admin/groups/:id', async ctx => {
  const r = db.prepare('DELETE FROM license_groups WHERE id=? AND workspace_id=?').run(ctx.params.id, ctx.wsId);
  if (!r.changes) throw new HttpError(404, 'Not found');
  wl(ctx, 'group.delete', ctx.params.id);
  return [200, { ok: true }];
}, { perm: 'groups.manage' });

// Admin: settings + audit -----------------------------------------------------
const WS_SETTING_KEYS = ['default_limit', 'claims_enabled', 'public_removal', 'heartbeat_minutes', 'grace_minutes', 'bbb_group_id'];
route('GET', '/api/admin/settings', async ctx => {
  const w = ctx.wsId;
  const out = {
    role: ctx.admin.role,
    ...Object.fromEntries(WS_SETTING_KEYS.map(k => [k, core.getSetting(k, w)])),
    bbb_secret: bbbSecretOf(w),
    bbb_callback_url: `${publicBase(ctx.req)}/api/v1/builtbybit/license`,
    public_url_set: !!PUBLIC_URL,
  };
  out.site_access = ctx.admin.role === 'platform' || can(ctx, 'platform.site'); // may edit the public name/links
  if (out.site_access) Object.assign(out, Object.fromEntries(SITE_KEYS.map(k => [k, core.getSetting(k)])));
  if (ctx.admin.role === 'platform') Object.assign(out, {
    admin_emails: parseEmails(core.getSetting('admin_emails')), admin_emails_config: CONFIG_ADMIN_EMAILS, password_login: !DISABLE_PASSWORD_LOGIN,
    oauth: Object.fromEntries(Object.keys(PROVIDERS).map(p => [p, { label: PROVIDERS[p].label, configured: !!oauthConf[p], callback_url: `${publicBase(ctx.req)}/auth/${p}/callback` }])),
  });
  return [200, out];
}, { perm: 'settings.manage' });
const httpUrl = (v, label) => {
  v = String(v ?? '').trim().slice(0, 300);
  if (!v) return '';
  let u; try { u = new URL(v); } catch { throw new HttpError(400, `${label} must be a full link, e.g. https://discord.gg/yourinvite`); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, `${label} must start with http:// or https://`);
  return u.href;
};
route('PUT', '/api/admin/settings', async ctx => {
  const b = await body(ctx.req), w = ctx.wsId;
  // the public site name/links can be handed to staff (platform.site); who may sign in as an admin never can
  if (SITE_KEYS.some(k => k in b) && ctx.admin.role !== 'platform' && !can(ctx, 'platform.site')) throw new HttpError(403, 'Only the site owner can change those settings.');
  if ('admin_emails' in b && ctx.admin.role !== 'platform') throw new HttpError(403, 'Only the site owner can change those settings.');
  if ('default_limit' in b) core.setSetting('default_limit', int(b.default_limit, { min: -1, max: 100000 }), w);
  if ('heartbeat_minutes' in b) core.setSetting('heartbeat_minutes', int(b.heartbeat_minutes, { min: 1, max: 1440 }), w);
  if ('grace_minutes' in b) core.setSetting('grace_minutes', int(b.grace_minutes, { min: 0, max: 20160 }), w);
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
}, { perm: 'settings.manage' });
route('GET', '/api/admin/audit', async ctx => [200, db.prepare('SELECT * FROM audit WHERE workspace_id=? ORDER BY id DESC LIMIT ?').all(ctx.wsId, Math.max(1, Math.min(Number(ctx.url.searchParams.get('limit')) || 100, 500)))], { perm: 'audit.view' });

// Workspaces, plans and billing ----------------------------------------------------
const slugKey = /^[a-z0-9][a-z0-9-]{1,23}$/;
const planView = p => ({ key: p.key, name: p.name, description: p.description, price_cents: p.price_cents, currency: p.currency, interval: p.interval,
  max_products: p.max_products, max_licenses: p.max_licenses, features: p.features.split('\n').map(x => x.trim()).filter(Boolean), highlight: !!p.highlight,
  buy_url: p.buy_url || '' });

function workspaceSummary(w) {
  const plan = core.planOf(w.id), entitled = core.entitledPlanKey(w);
  return { id: w.id, name: w.name, house: w.id === HOUSE, owner_email: w.owner_email, created_at: w.created_at,
    suspended: !!w.suspended, suspended_reason: w.suspended_reason,
    plan: planView({ features: '', currency: 'usd', description: '', highlight: 0, ...plan }),
    plan_key: w.plan_key, plan_status: w.plan_status, plan_until: w.plan_until, plan_source: w.plan_source, plan_note: w.plan_note || '',
    lapsed: w.plan_key !== 'free' && entitled === 'free', usage: core.usage(w.id),
    heartbeat_minutes: Number(core.getSetting('heartbeat_minutes', w.id)) || 1 };
}
route('GET', '/api/workspace', async ctx => {
  const summary = workspaceSummary(db.prepare('SELECT * FROM workspaces WHERE id=?').get(ctx.wsId));
  if (ctx.admin.role !== 'member') return [200, summary];
  // a team member needs to know where they are and whether it is frozen, not the owner's plan, billing or workspace-wide totals
  const { id, name, house, suspended, suspended_reason, lapsed, heartbeat_minutes } = summary;
  return [200, { id, name, house, suspended, suspended_reason, lapsed, heartbeat_minutes, plan: { key: '', name: '', max_products: -1, max_licenses: -1, price_cents: 0, interval: 'free' }, usage: null }];
}, { admin: true, allowSuspended: true });

// Public pricing: the plans that are for sale (bought on BuiltByBit, where each plan's link points) and how else to reach the owner.
route('GET', '/api/public/pricing', async ctx => {
  const plans = db.prepare('SELECT * FROM plans WHERE active=1 ORDER BY sort, price_cents').all().map(planView);
  const u = sessionUser(ctx.req), w = workspaceOfUser(u);
  return [200, { plans, signups: SIGNUPS_OPEN, site: Object.fromEntries(SITE_KEYS.map(k => [k, core.getSetting(k)])),
    current: w ? { plan_key: core.entitledPlanKey(w), status: w.plan_status, until: w.plan_until } : null }];
});

// A signed-in person gets their own private workspace (on the Free plan). Needs a verified email: that is who owns it.
const createWorkspaceFor = (u, { force = false } = {}) => {
  if (!SIGNUPS_OPEN && !force) throw new HttpError(403, 'Signups are closed. Contact the site owner for an invitation.');
  if (!u.email) throw new HttpError(400, `${u.p} did not share a verified email address, so we cannot create an account. Sign in with a provider that does.`);
  const r = db.prepare('INSERT INTO workspaces (name, owner_email, owner_name, bbb_secret, created_at) VALUES (?,?,?,?,?)')
    .run(str(u.name, 60) || u.email.split('@')[0], u.email, str(u.name, 80), newSecret(), now());
  core.log('user', 'workspace.create', u.email, u.p, Number(r.lastInsertRowid));
  ensurePrototype(Number(r.lastInsertRowid));
  return db.prepare('SELECT * FROM workspaces WHERE id=?').get(r.lastInsertRowid);
};
route('POST', '/api/workspace/ensure', async ctx => {
  const u = sessionUser(ctx.req);
  if (!u) throw new HttpError(401, 'Sign in first.');
  const existing = workspaceOfUser(u);
  if (existing) return [200, workspaceSummary(existing)];
  if (!SIGNUPS_OPEN) throw new HttpError(403, 'Signups are closed. Contact the site owner for an invitation.');
  if (!rateLimit('ws:' + ctx.ip, Number(process.env.LICENSEX_SIGNUPS_PER_IP_HOUR || 10), 3600e3)) throw new HttpError(429, 'Too many accounts created from this address. Try again later.');
  return [201, workspaceSummary(createWorkspaceFor(u))];
});

// Activating a plan that was bought on BuiltByBit: the buyer pastes the access key from the file they downloaded there.
// Only the owner of a workspace can switch its plan on. See server/plansales.js.
route('POST', '/api/billing/redeem', async ctx => {
  const u = sessionUser(ctx.req);
  if (!u) throw new HttpError(401, 'Sign in first.');
  if (!rateLimit('redeem:' + (u.email || u.id), 10, 60e3) || !rateLimit('redeem-ip:' + ctx.ip, 30, 60e3)) throw new HttpError(429, 'Too many attempts. Wait a minute.');
  const b = await body(ctx.req);
  let w = workspaceOfUser(u);
  try {
    if (!w) {                          // a first-time buyer: a valid key is their invitation, so their account is created together with the plan (even when signups are closed)
      lookupKey({ db, key: b.key });
      if (!rateLimit('ws:' + ctx.ip, Number(process.env.LICENSEX_SIGNUPS_PER_IP_HOUR || 10), 3600e3)) throw new HttpError(429, 'Too many accounts created from this address. Try again later.');
      w = createWorkspaceFor(u, { force: true });
    }
    const { plan, until } = redeemKey({ db, core, workspace: w, key: b.key });
    return [200, { ok: true, message: `${plan.name} is active${until ? ` until ${new Date(until * 1000).toLocaleDateString('en-GB')}` : ', with no end date'}.`, workspace: workspaceSummary(db.prepare('SELECT * FROM workspaces WHERE id=?').get(w.id)) }];
  } catch (e) {
    if (e instanceof RedeemError) throw new HttpError(e.status, e.message, e.code);
    throw e;
  }
});

// Platform: customers ------------------------------------------------------------
const customerRow = w => ({ ...workspaceSummary(w), licenses: core.usage(w.id).licenses, products: core.usage(w.id).products });
route('GET', '/api/admin/customers', async () => [200, db.prepare('SELECT * FROM workspaces ORDER BY id').all().map(customerRow)], { perm: 'platform.customers' });
// Invite: create a workspace for an email address. Whoever signs in with that VERIFIED email owns it, even when signups are closed.
route('POST', '/api/admin/customers', async ctx => {
  const b = await body(ctx.req);
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (db.prepare('SELECT 1 FROM workspaces WHERE owner_email=?').get(email)) throw new HttpError(409, 'That email already has an account.');
  const plan = db.prepare('SELECT * FROM plans WHERE key=?').get(str(b.plan_key || 'free', 30));
  if (!plan) throw new HttpError(400, 'Unknown plan');
  const until = int(b.until, { min: 1, max: 4e10, nullable: true });
  const r = db.prepare('INSERT INTO workspaces (name, owner_email, owner_name, plan_key, plan_until, plan_source, bbb_secret, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(str(b.name, 60).trim() || email.split('@')[0], email, str(b.name, 80).trim(), plan.key, plan.key === 'free' ? null : until, plan.key === 'free' ? 'free' : 'manual', newSecret(), now());
  core.log('admin', 'customer.invite', email, plan.key, Number(r.lastInsertRowid));
  return [201, customerRow(db.prepare('SELECT * FROM workspaces WHERE id=?').get(r.lastInsertRowid))];
}, { perm: 'platform.customers' });
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
}, { perm: 'platform.customers' });
route('POST', '/api/admin/customers/:id/suspend', async ctx => {
  const w = customer(ctx), b = await body(ctx.req);
  db.prepare('UPDATE workspaces SET suspended=?, suspended_reason=? WHERE id=?').run(b.suspended ? 1 : 0, b.suspended ? str(b.reason, 200) : '', w.id);
  core.log('admin', b.suspended ? 'customer.suspend' : 'customer.unsuspend', w.owner_email, str(b.reason, 200), w.id);
  return [200, customerRow(db.prepare('SELECT * FROM workspaces WHERE id=?').get(w.id))];
}, { perm: 'platform.customers' });
route('DELETE', '/api/admin/customers/:id', async ctx => {
  const w = customer(ctx);
  for (const p of db.prepare('SELECT slug FROM products WHERE workspace_id=?').all(w.id)) rmSync(productFile(p.slug), { force: true });
  db.exec('BEGIN');
  try {
    for (const t of ['members', 'roles', 'downloads', 'licenses', 'products', 'license_groups', 'ws_settings', 'audit']) db.prepare(`DELETE FROM ${t} WHERE workspace_id=?`).run(w.id); // servers, buyer links and member scopes go with their parents
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
  const buy_url = httpUrl(b.buy_url, 'Buy link');
  const bbb_resource_id = str(b.bbb_resource_id, 12).trim();
  if (bbb_resource_id && !/^\d{1,12}$/.test(bbb_resource_id)) throw new HttpError(400, 'The BuiltByBit resource id is the number in the resource\'s address.');
  if (bbb_resource_id && key === 'free') throw new HttpError(400, 'The Free plan is not sold.');
  if (bbb_resource_id && db.prepare('SELECT 1 FROM plans WHERE bbb_resource_id=? AND key!=?').get(bbb_resource_id, key)) throw new HttpError(409, 'Another plan already uses that BuiltByBit resource id.');
  return { key, name, description: str(b.description, 140).trim(), price_cents: price, currency, interval, buy_url: key === 'free' ? '' : buy_url, bbb_resource_id,
    max_products: int(b.max_products, { min: -1, max: 100000 }), max_licenses: int(b.max_licenses, { min: -1, max: 10000000 }),
    features, highlight: b.highlight ? 1 : 0, active: b.active === false ? 0 : 1, sort: int(b.sort ?? 0, { min: 0, max: 1000 }) };
};
route('GET', '/api/admin/plans', async () => [200, db.prepare('SELECT p.*, (SELECT COUNT(*) FROM workspaces w WHERE w.plan_key = p.key) customers FROM plans p ORDER BY sort, price_cents').all()], { platform: true });
route('POST', '/api/admin/plans', async ctx => {
  const f = planFields(await body(ctx.req), null);
  if (db.prepare('SELECT 1 FROM plans WHERE key=?').get(f.key)) throw new HttpError(409, 'A plan with that key exists');
  db.prepare('INSERT INTO plans (key,name,description,price_cents,currency,interval,max_products,max_licenses,features,highlight,active,sort,buy_url,bbb_resource_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(f.key, f.name, f.description, f.price_cents, f.currency, f.interval, f.max_products, f.max_licenses, f.features, f.highlight, f.active, f.sort, f.buy_url, f.bbb_resource_id);
  core.log('admin', 'plan.create', f.key, f.name);
  return [201, { ok: true }];
}, { platform: true });
route('PATCH', '/api/admin/plans/:key', async ctx => {
  const cur = db.prepare('SELECT * FROM plans WHERE key=?').get(ctx.params.key);
  if (!cur) throw new HttpError(404, 'Not found');
  const f = planFields({ ...cur, ...(await body(ctx.req)) }, cur);
  db.prepare('UPDATE plans SET name=?,description=?,price_cents=?,currency=?,interval=?,max_products=?,max_licenses=?,features=?,highlight=?,active=?,sort=?,buy_url=?,bbb_resource_id=? WHERE key=?')
    .run(f.name, f.description, f.price_cents, f.currency, f.interval, f.max_products, f.max_licenses, f.features, f.highlight, f.key === 'free' ? 1 : f.active, f.sort, f.buy_url, f.bbb_resource_id, f.key);
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
// Every copy also carries a random `mark` (in licensex.json and in the zip comment) that the leak tracer looks up.
function licensedJar(req, p, key, mark = '') {
  const jar = readFileSync(productFile(p.slug));
  const cfg = { url: publicBase(req), key, product: p.name, mark, secret: SESSION_SECRET };
  let out;
  try { out = wrapJar(jar, cfg).jar; }
  catch (e) {
    if (!(e instanceof WrapError)) throw e;
    if (e.code !== 'ALREADY_INTEGRATED') throw new HttpError(503, `This download is unavailable: ${e.message}`, e.code);
    out = injectFiles(jar, [{ name: 'licensex.json', content: JSON.stringify({ ...cfg, issued: now() }) }]);
  }
  return mark ? setZipComment(out, mark) : out;
}

// --- public download (BuiltByBit points here) ------------------------------
// GET /download/:slug?token=...&nonce=...&user=...
// Issues a license for the nonce (new per nonce, stable on repeat), stamps the key into the jar and serves it.
let downloadsNow = 0;
const MAX_DOWNLOADS_NOW = Math.max(1, Number(process.env.LICENSEX_MAX_DOWNLOADS || fileConfig.maxDownloads || 8));
function handleDownload(req, res, slug, url) {
  const ip = clientIp(req);
  if (!rateLimit('dl:' + ip, 60, 60e3)) throw new HttpError(429, 'Too many downloads. Try again shortly.');
  const p = db.prepare('SELECT * FROM products WHERE slug=?').get(slug);
  if (!p || !p.has_file || !p.enabled) throw new HttpError(404, 'This download is not available.');
  if (!safeEq(url.searchParams.get('token') || '', p.token)) throw new HttpError(403, 'Invalid or missing download token.');
  if (req.method === 'HEAD') { // link checkers and previews: answer, but never mint a license or count a download
    res.writeHead(200, { 'Content-Type': 'application/java-archive', 'Cache-Control': 'no-store' });
    return res.end();
  }
  // The stamped jar is built in memory, so only a few downloads run at once and a client that stops reading is cut off.
  if (downloadsNow >= MAX_DOWNLOADS_NOW) { res.setHeader('Retry-After', '5'); throw new HttpError(503, 'Busy right now. Please try again in a few seconds.'); }
  downloadsNow++;
  res.once('close', () => { downloadsNow--; });
  res.setTimeout(60e3, () => res.destroy());

  // A known buyer (?user=) always gets the same license. With no buyer id and no (real) nonce - e.g. someone
  // opening the raw link - there is nothing to match on, so that download gets a fresh license.
  const nonce = str(url.searchParams.get('nonce'), 128).trim();
  const r = core.claim({ ws: p.workspace_id, nonce: nonce.includes('%%') || !nonce ? 'anon-' + randomBytes(12).toString('hex') : nonce,
    user: str(url.searchParams.get('user'), 64), name: str(url.searchParams.get('name'), 64), product: p.name, product_id: p.id, scope: 'p#' + p.id, group_id: p.group_id, ip, device: hash(ip + req.headers['user-agent']),
    canMint: () => recentCount('mint:p' + p.id, 3600e3) < MINT_PER_PRODUCT_HOUR && recentCount('mint:ip' + ip, 3600e3) < MINT_PER_IP_HOUR });
  if (!r.ok) {
    if (r.code === 'PLAN_LIMIT') { // the public must not learn which plan the developer is on; the developer sees why in the audit log
      core.log('system', 'download.refused', p.slug, r.message, p.workspace_id);
      throw new HttpError(503, 'This download is temporarily unavailable. Please contact the developer.', 'UNAVAILABLE');
    }
    if (r.code === 'RATE_LIMIT') { core.log('system', 'download.throttled', p.slug, `ip=${ip}`, p.workspace_id); throw new HttpError(429, r.message, r.code); }
    throw new HttpError(403, r.message, r.code);
  }
  if (r.created) { rateLimit('mint:p' + p.id, Infinity, 3600e3); rateLimit('mint:ip' + ip, Infinity, 3600e3); } // only licenses actually issued count against the caps

  const mark = randomBytes(8).toString('hex');
  const stamped = licensedJar(req, p, r.key, mark);
  db.prepare('UPDATE products SET downloads = downloads + 1 WHERE id=?').run(p.id);
  const lic = db.prepare('SELECT id FROM licenses WHERE key = ?').get(r.key);
  db.prepare('INSERT INTO downloads (workspace_id, product_id, license_id, license_key, mark, ip, user_agent, bbb_user, at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(p.workspace_id, p.id, lic?.id ?? null, r.key, mark, ip, str(req.headers['user-agent'], 200), str(url.searchParams.get('user'), 64), now());
  core.log('system', 'product.download', p.slug, `${r.key} ip=${ip}`, p.workspace_id);

  const dlName = (p.filename && /\.(jar|zip)$/i.test(p.filename) ? p.filename : slugify(p.name) + '.jar');
  res.writeHead(200, { 'Content-Type': 'application/java-archive', 'Content-Length': stamped.length,
    'Content-Disposition': `attachment; filename="${dlName.replace(/[^\w.\-]/g, '_')}"`, 'Cache-Control': 'no-store' });
  res.end(stamped);
}

// --- feature modules: each registers its own routes -------------------------------
// They get the pieces of this file they need through one object, so they can live (and be tested) in their own files.
const app = { route, db, core, HttpError, body, int, str, rateLimit, recentCount, clientIp, publicBase, sessionUser, cookies, isHttps, secure, sign, signToken, readToken, safeEq,
  PUBLIC_URL, DATA, SESSION_SECRET, HOUSE, now, hash, normalizeKey, KEY_RE, fileConfig, CONFIG_ADMIN_EMAILS, isAdminUser, workspaceOfUser, redirect };
registerBuyers(app);
registerTeam(app);
registerPlanSales(app);
const patreon = registerPatreon(app);
for (const { id } of db.prepare('SELECT id FROM workspaces').all()) { try { ensurePrototype(id); } catch (e) { console.error(`[LicenseX] prototype for workspace ${id}: ${e.message}`); } }

// --- static + dispatch -----------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/dashboard') pathname = '/admin.html';
  if (pathname === '/pricing') pathname = '/pricing.html';
  if (pathname === '/login' || pathname === '/login/creator' || pathname === '/login/buyer' || pathname === '/login/2fa') pathname = '/login.html';
  if (pathname === '/account') pathname = '/account.html';
  const file = resolve(WEB, '.' + pathname);
  const rel = relative(WEB, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { ok: false, message: 'Not found' });
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}

export const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com https://avatars.githubusercontent.com https://cdn.discordapp.com; frame-ancestors 'none'");
  try {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { throw new HttpError(400, 'Bad request'); }
    const dl = url.pathname.match(/^\/download\/([a-z0-9-]{1,48})$/);
    if (dl) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return handleDownload(req, res, dl[1], url);
    }
    if (url.pathname === '/auth/patreon' || url.pathname === '/auth/patreon/callback') return await patreon.handle(req, res, url);
    if (url.pathname.startsWith('/auth/')) return await handleAuth(req, res, url);
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      let path;
      try { path = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Bad request'); }
      return serveStatic(req, res, path);
    }
    for (const [method, re, handler, opts] of routes) {
      const m = req.method === method && re.exec(url.pathname);
      if (!m) continue;
      const guarded = !!(opts.admin || opts.platform || opts.perm);
      /** Who is calling and what they may do. Run again once the request body has arrived (see body()): a person who was switched off while their request was still uploading must not get through. */
      const authorize = () => {
        const admin = adminIdentity(req, url);
        if (!guarded) return { admin, wsId: HOUSE, access: null };
        if (!admin) throw new HttpError(401, 'Not signed in');
        if (opts.platform && admin.role !== 'platform') throw new HttpError(403, 'Only the site owner can do that.');
        if (opts.build && !canBuild(admin)) throw new HttpError(403, 'Build from source is not switched on for customers on this server.');
        const wsId = resolveWorkspace(admin, req, url), access = accessFor(db, admin, wsId);
        const needed = opts.perm ? [].concat(opts.perm) : [];
        if (needed.length && !needed.some(k => access.perms.has(k))) throw new HttpError(403, 'You do not have permission to do that.', 'FORBIDDEN');
        // A suspended customer can still look around (and read their data), but nothing can be changed.
        if (admin.role !== 'platform' && req.method !== 'GET' && core.isSuspended(wsId) && !opts.allowSuspended) throw new HttpError(403, 'This account is suspended. Contact support.');
        return { admin, wsId, access };
      };
      const ctx = { req, url, params: m.groups || {}, ip: clientIp(req), ...authorize() };
      if (guarded) req.lxRecheck = () => {
        const now = authorize();
        if (now.wsId !== ctx.wsId) throw new HttpError(401, 'Not signed in');
        ctx.admin = now.admin; ctx.access = now.access;
      };
      const [status, payload, headers] = await handler(ctx);
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
  if (offsite.enabled) {
    // Render and most hosts send SIGTERM and wait a few seconds before stopping: send a last copy first
    let stopping = false;
    const stop = async sig => {
      if (stopping) return; stopping = true;
      console.log(`[LicenseX] ${sig}: sending a last off-site backup before stopping...`);
      const r = OFFSITE.blocked ? null : await Promise.race([offsite.run({ reason: 'shutdown' }).catch(e => ({ message: e.message })), new Promise(r => setTimeout(r, 25e3))]);
      console.log('[LicenseX] backup:', r ? JSON.stringify(r.results || r.message) : 'skipped or timed out');
      process.exit(0);
    };
    process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
    if (!OFFSITE.blocked) offsite.start();
  }
  server.listen(PORT, () => {
    console.log(`[LicenseX] listening on http://localhost:${server.address().port}  (admin: /admin)`);
    if (!PUBLIC_URL && (TRUST_PROXY || process.env.NODE_ENV === 'production'))
      console.warn('[LicenseX] LICENSEX_PUBLIC_URL is not set. Download links, the license address baked into plugins and sign-in redirects are guessed from each request, which can be wrong behind a proxy. Set it to your real https address.');
  });
}
