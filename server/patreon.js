// Patreon: a paying patron's LicenseX account gets a paid plan, renewed automatically on every charge.
//
//  - Patreon calls our webhook on every pledge change and charge (signed with the webhook secret: HMAC-MD5 of the body).
//  - A patron is tied to a LicenseX account either by "Connect Patreon" on the Billing page (Patreon sign-in, so the two
//    emails may differ) or automatically when their Patreon email is the verified email they sign in to LicenseX with.
//  - Paid charge -> the plan runs until the next charge date (+3 days). No payment -> it simply runs out. Nothing is
//    ever switched off early, and existing licenses keep working when a plan ends (see core.entitledPlanKey).
// Setup: docs/PATREON.md.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DAY = 86400, GRACE = 3 * DAY;

export function patreonConfig(fileConfig = {}) {
  const f = fileConfig.patreon || {};
  const c = {
    clientId: process.env.LICENSEX_PATREON_CLIENT_ID || f.clientId || '',
    clientSecret: process.env.LICENSEX_PATREON_CLIENT_SECRET || f.clientSecret || '',
    webhookSecret: process.env.LICENSEX_PATREON_WEBHOOK_SECRET || f.webhookSecret || '',
    plan: process.env.LICENSEX_PATREON_PLAN || f.plan || 'pro',
    // which tier gives which plan: { "<tier id>": "<plan key>" }; empty = every paid tier gives `plan`
    tiers: process.env.LICENSEX_PATREON_TIERS
      ? Object.fromEntries(process.env.LICENSEX_PATREON_TIERS.split(',').map(x => x.split(':').map(y => y.trim())).filter(x => x[0] && x[1]))
      : (f.tiers && typeof f.tiers === 'object' ? Object.fromEntries(Object.entries(f.tiers).map(([k, v]) => [String(k), String(v)])) : {}),
  };
  return { ...c, connect: !!(c.clientId && c.clientSecret), webhook: !!c.webhookSecret };
}

export const signPatreon = (raw, secret) => createHmac('md5', secret).update(raw).digest('hex');

/** The parts of a Patreon "member" we use, from a webhook body or an identity response. */
function memberOf(data, included = []) {
  const a = data?.attributes || {};
  const userId = String(data?.relationships?.user?.data?.id || '');
  const user = included.find(x => x.type === 'user' && x.id === userId);
  const ts = v => (v ? Math.floor(Date.parse(v) / 1000) || null : null);
  return { userId, email: String(a.email || user?.attributes?.email || '').toLowerCase(), status: String(a.patron_status || ''),
    charge: String(a.last_charge_status || ''), lastCharge: ts(a.last_charge_date), nextCharge: ts(a.next_charge_date),
    tiers: (data?.relationships?.currently_entitled_tiers?.data || []).map(t => String(t.id)) };
}

export function registerPatreon(app) {
  const { route, db, core, HttpError, rateLimit, sessionUser, workspaceOfUser, redirect, signToken, readToken, cookies, secure, publicBase, fileConfig } = app;
  const conf = patreonConfig(fileConfig);
  const API = process.env.LICENSEX_PATREON_TEST_BASE || 'https://www.patreon.com';
  const now = () => Math.floor(Date.now() / 1000);

  db.exec(`CREATE TABLE IF NOT EXISTS patreon_members (
    user_id TEXT PRIMARY KEY, email TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', charge TEXT NOT NULL DEFAULT '',
    last_charge INTEGER, next_charge INTEGER, workspace_id INTEGER UNIQUE, updated_at INTEGER NOT NULL)`);
  if (!db.prepare('PRAGMA table_info(patreon_members)').all().some(c => c.name === 'tiers')) db.exec("ALTER TABLE patreon_members ADD COLUMN tiers TEXT NOT NULL DEFAULT ''");

  const save = m => db.prepare(`INSERT INTO patreon_members (user_id, email, status, charge, last_charge, next_charge, tiers, updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET email=excluded.email, status=excluded.status, charge=excluded.charge, last_charge=excluded.last_charge, next_charge=excluded.next_charge, tiers=excluded.tiers, updated_at=excluded.updated_at`)
    .run(m.userId, m.email, m.status, m.charge, m.lastCharge, m.nextCharge, (m.tiers || []).join(','), now());
  /** The plan this patron's tier gives: with a tier list, the priciest plan among their tiers (none if no tier is listed). */
  function planFor(r) {
    const mapped = Object.keys(conf.tiers).length;
    const keys = mapped ? String(r.tiers || '').split(',').map(t => conf.tiers[t]).filter(Boolean) : [conf.plan];
    return keys.map(k => db.prepare('SELECT * FROM plans WHERE key = ?').get(k)).filter(Boolean).sort((a, b) => b.price_cents - a.price_cents)[0] || null;
  }

  /** Gives the linked account the plan while this patron is paid up. Returns the end date it set, or null. */
  function apply(userId) {
    const r = db.prepare('SELECT * FROM patreon_members WHERE user_id = ?').get(userId);
    if (!r?.workspace_id || r.status !== 'active_patron' || r.charge !== 'Paid') return null;
    const plan = planFor(r);
    const w = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(r.workspace_id);
    if (!plan || !w) return null;
    if (w.plan_key !== 'free' && !w.plan_until && w.plan_status !== 'canceled') return null;   // already has a plan with no end date
    const until = (r.next_charge || (r.last_charge || now()) + 31 * DAY) + GRACE;
    if (w.plan_key === plan.key && w.plan_until >= until) return w.plan_until;                 // repeated webhook: nothing new
    db.prepare("UPDATE workspaces SET plan_key = ?, plan_status = 'active', plan_until = ?, plan_source = 'manual', plan_note = ? WHERE id = ?")
      .run(plan.key, until, `Patreon ${r.email || r.user_id}`, w.id);
    core.log('patreon', 'plan.patreon', plan.key, `until ${new Date(until * 1000).toISOString().slice(0, 10)}`, w.id);
    return until;
  }
  /** Ties a patron to an account (one each way). */
  function link(userId, wsId) {
    db.prepare('UPDATE patreon_members SET workspace_id = NULL WHERE workspace_id = ? AND user_id <> ?').run(wsId, userId);
    db.prepare('UPDATE patreon_members SET workspace_id = ? WHERE user_id = ?').run(wsId, userId);
  }
  /** A patron nobody linked yet, whose Patreon email owns an account: link it. */
  function autoLink(m) {
    const r = db.prepare('SELECT workspace_id FROM patreon_members WHERE user_id = ?').get(m.userId);
    if (r?.workspace_id || !m.email) return;
    const w = db.prepare('SELECT id FROM workspaces WHERE lower(owner_email) = ?').get(m.email);
    if (w && !db.prepare('SELECT 1 FROM patreon_members WHERE workspace_id = ?').get(w.id)) link(m.userId, w.id);
  }

  // Patreon -> us: every pledge change and charge.
  route('POST', '/api/patreon/webhook', async ctx => {
    if (!conf.webhook) throw new HttpError(404, 'Patreon is not set up on this server.');
    const chunks = []; let size = 0;
    for await (const c of ctx.req) { size += c.length; if (size > 262144) throw new HttpError(413, 'Body too large'); chunks.push(c); }
    const raw = Buffer.concat(chunks), sig = String(ctx.req.headers['x-patreon-signature'] || '');
    const want = Buffer.from(signPatreon(raw, conf.webhookSecret)), got = Buffer.from(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'Bad signature');
    let msg; try { msg = JSON.parse(raw.toString()); } catch { throw new HttpError(400, 'Invalid JSON'); }
    const m = memberOf(msg.data, msg.included);
    if (!m.userId) return [200, { ok: true, ignored: true }];
    save(m); autoLink(m);
    const until = apply(m.userId);
    core.log('patreon', 'patreon.event', String(ctx.req.headers['x-patreon-event'] || ''), `${m.email || m.userId} ${m.status}/${m.charge} tiers=${(m.tiers || []).join(',') || 'none'}`);
    return [200, { ok: true, until }];
  });

  // What the Billing page shows.
  route('GET', '/api/billing/patreon', async ctx => {
    const u = sessionUser(ctx.req), w = workspaceOfUser(u);
    if (!w) throw new HttpError(401, 'Sign in first.');
    const r = db.prepare('SELECT email, status, charge, next_charge FROM patreon_members WHERE workspace_id = ?').get(w.id);
    return [200, { enabled: conf.connect, linked: r ? { email: r.email, active: r.status === 'active_patron' && r.charge === 'Paid', next_charge: r.next_charge } : null }];
  });

  // "Connect Patreon": a Patreon sign-in proves which patron this is.
  const cookieName = 'lx_patreon';
  const back = (res, q, extra = []) => redirect(res, `/admin${q ? '?' + q : ''}#billing`, [`${cookieName}=; HttpOnly; SameSite=Lax; Path=/auth/patreon; Max-Age=0`, ...extra]);
  async function handle(req, res, url) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    if (!conf.connect) return back(res, 'patreon=notconfigured');
    const u = sessionUser(req), w = workspaceOfUser(u);
    if (!w) return redirect(res, '/login?next=/admin');
    if (!rateLimit('patreon:' + w.id, 20, 60e3)) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
    const redirectUri = `${publicBase(req)}/auth/patreon/callback`;
    if (url.pathname === '/auth/patreon') {
      const state = randomBytes(18).toString('base64url');
      const q = new URLSearchParams({ response_type: 'code', client_id: conf.clientId, redirect_uri: redirectUri, scope: 'identity identity[email] identity.memberships', state });
      return redirect(res, `${API}/oauth2/authorize?${q}`, [`${cookieName}=${signToken({ s: state, w: w.id, exp: Date.now() + 600e3 })}; HttpOnly; SameSite=Lax; Path=/auth/patreon; Max-Age=600${secure(req)}`]);
    }
    if (url.pathname !== '/auth/patreon/callback') throw new HttpError(404, 'Not found');
    const pending = readToken(cookies(req)[cookieName]), state = url.searchParams.get('state') || '';
    if (!pending || pending.w !== w.id || pending.s !== state) return back(res, 'patreon=state');
    const code = url.searchParams.get('code');
    if (!code) return back(res, 'patreon=denied');
    try {
      const tok = await fetch(`${API}/api/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: conf.clientId, client_secret: conf.clientSecret, redirect_uri: redirectUri }) }).then(r => r.json());
      if (!tok.access_token) throw new Error('no access token');
      const q = 'include=memberships,memberships.currently_entitled_tiers&fields%5Buser%5D=email&fields%5Bmember%5D=patron_status,last_charge_status,last_charge_date,next_charge_date,email';
      const me = await fetch(`${API}/api/oauth2/v2/identity?${q}`, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then(r => r.json());
      const userId = String(me.data?.id || '');
      if (!userId) throw new Error('no Patreon user');
      const membership = (me.included || []).find(x => x.type === 'member');
      const m = membership ? memberOf({ ...membership, relationships: { ...membership.relationships, user: { data: { id: userId } } } }) : { userId, status: '', charge: '', lastCharge: null, nextCharge: null, email: '', tiers: [] };
      m.email ||= String(me.data?.attributes?.email || '').toLowerCase();
      const known = db.prepare('SELECT * FROM patreon_members WHERE user_id = ?').get(userId);
      if (known?.workspace_id && known.workspace_id !== w.id) return back(res, 'patreon=taken');
      // the identity call is fresh, but if Patreon only told us about a charge by webhook, keep that
      if (!membership && known) Object.assign(m, { status: known.status, charge: known.charge, lastCharge: known.last_charge, nextCharge: known.next_charge, tiers: known.tiers ? known.tiers.split(',') : [] });
      save(m); link(userId, w.id);
      const until = apply(userId);
      core.log('user', 'patreon.connect', m.email || userId, until ? 'plan on' : 'not paying yet', w.id);
      return back(res, until ? 'patreon=active' : 'patreon=linked');
    } catch (e) {
      core.log('system', 'patreon.error', 'connect', e.message, w.id);
      return back(res, 'patreon=failed');
    }
  }
  route('POST', '/api/billing/patreon/disconnect', async ctx => {
    const w = workspaceOfUser(sessionUser(ctx.req));
    if (!w) throw new HttpError(401, 'Sign in first.');
    db.prepare('UPDATE patreon_members SET workspace_id = NULL WHERE workspace_id = ?').run(w.id);
    return [200, { ok: true }];
  });
  return { handle, conf, apply };
}
