import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- a fake Google/Discord/GitHub: authorize -> token -> userinfo, with whatever profile the test sets
let nextProfile = null;                     // what the "person at the provider" is
const codes = new Map();                    // code -> profile
const mock = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const [, provider, endpoint] = u.pathname.split('/');
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (endpoint === 'authorize') {
    const code = 'code-' + codes.size; codes.set(code, nextProfile);
    return send(302, {}, { Location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` });
  }
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    if (endpoint === 'token') {
      const f = new URLSearchParams(body);
      if (f.get('client_id') !== `id-${provider}` || f.get('client_secret') !== `secret-${provider}` || !codes.has(f.get('code'))) return send(400, { error: 'invalid_grant' });
      return send(200, { access_token: 'tok-' + f.get('code') });
    }
    const p = codes.get((req.headers.authorization || '').replace('Bearer tok-', ''));
    if (!p) return send(401, { message: 'bad token' });
    if (endpoint === 'emails') return send(200, p.emails || []);
    return send(200, p.user);
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));

process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-oauth-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_OAUTH_TEST_BASE = `http://127.0.0.1:${mock.address().port}`;
process.env.LICENSEX_ADMIN_EMAILS = 'Boss@Example.com';
for (const p of ['GOOGLE', 'DISCORD', 'GITHUB']) { process.env[`LICENSEX_${p}_CLIENT_ID`] = `id-${p.toLowerCase()}`; process.env[`LICENSEX_${p}_CLIENT_SECRET`] = `secret-${p.toLowerCase()}`; }
const { server } = await import('../server/index.js');
let base;
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => { server.close(); mock.close(); });

const raw = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const cookiesOf = res => Object.fromEntries(res.headers.getSetCookie().map(c => c.split(';')[0].split(/=(.*)/s).slice(0, 2)));
const json = (method, path, body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));

/** Full browser-style round trip. Returns the lx_user cookie (or '' if login failed) and where it ended up. */
async function login(provider, profile, next = '') {
  nextProfile = profile;
  const start = await raw(`/auth/${provider}${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  assert.equal(start.status, 302);
  const oauth = 'lx_oauth=' + cookiesOf(start).lx_oauth;
  const atProvider = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = await raw(new URL(atProvider.headers.get('location')).pathname + new URL(atProvider.headers.get('location')).search, oauth);
  const c = cookiesOf(cb);
  return { cookie: c.lx_user ? 'lx_user=' + c.lx_user : '', location: cb.headers.get('location') };
}
const me = cookie => json('GET', '/api/auth/me', null, cookie).then(r => r.body);
const adminOk = async cookie => (await json('GET', '/api/admin/stats', null, cookie)).status === 200;

const google = (email, verified = true) => ({ user: { sub: 'g-' + email, email, email_verified: verified, name: 'Gee ' + email, picture: 'https://lh3.googleusercontent.com/a' } });
const discord = (email, verified = true) => ({ user: { id: 'd1', username: 'disc', global_name: 'Disc User', avatar: 'abc', email, verified } });
const github = (emails) => ({ user: { id: 99, login: 'octo', name: 'Octo', avatar_url: 'https://avatars.githubusercontent.com/u/99' }, emails });

test('providers are listed when configured', async () => {
  const m = await me('');
  assert.deepEqual(m.providers.map(p => p.id).sort(), ['discord', 'github', 'google']);
  assert.equal(m.user, null);
});

test('google: verified email on the admin list => admin button + admin access (case-insensitive)', async () => {
  const r = await login('google', google('boss@example.com'));
  assert.equal(r.location, '/');
  const m = await me(r.cookie);
  assert.equal(m.user.isAdmin, true);
  assert.equal(m.user.name, 'Gee boss@example.com');
  assert.equal(m.user.provider, 'google');
  assert.equal(await adminOk(r.cookie), true);
  assert.equal((await json('GET', '/api/admin/me', null, r.cookie)).body.via, 'google');
});

test('an UNVERIFIED email is never admin, even if it matches', async () => {
  for (const [p, prof] of [['google', google('boss@example.com', false)], ['discord', discord('boss@example.com', false)], ['github', github([{ email: 'boss@example.com', primary: true, verified: false }])]]) {
    const r = await login(p, prof);
    assert.ok(r.cookie, `${p} still signs in`);
    assert.equal((await me(r.cookie)).user.isAdmin, false, `${p} unverified`);
    assert.equal(await adminOk(r.cookie), false, `${p} admin API refused`);
  }
});

test('discord and github verified emails work; github accepts any verified email, not just the primary', async () => {
  const d = await login('discord', discord('boss@example.com'));
  assert.equal((await me(d.cookie)).user.isAdmin, true);
  assert.equal((await me(d.cookie)).user.avatar, 'https://cdn.discordapp.com/avatars/d1/abc.png?size=64');
  const g = await login('github', github([{ email: 'someone@else.com', primary: true, verified: true }, { email: 'boss@example.com', primary: false, verified: true }]));
  const m = await me(g.cookie);
  assert.equal(m.user.isAdmin, true);
  assert.equal(m.user.email, 'someone@else.com');         // shows the primary
});

test('a signed-in person who is not on the list is a normal user: no admin button, no admin API', async () => {
  const r = await login('google', google('random@example.com'));
  const m = await me(r.cookie);
  assert.equal(m.user.isAdmin, false);
  assert.equal(await adminOk(r.cookie), false);
  assert.equal((await json('GET', '/api/admin/me', null, r.cookie)).status, 401);
});

test('admin list from the settings page applies immediately, both ways, and is validated', async () => {
  const pw = (await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) })).headers.get('set-cookie').split(';')[0];
  const r = await login('google', google('newadmin@example.com'));
  assert.equal(await adminOk(r.cookie), false);

  assert.equal((await json('PUT', '/api/admin/settings', { admin_emails: 'NewAdmin@Example.com, other@x.io' }, pw)).status, 200);
  assert.equal((await me(r.cookie)).user.isAdmin, true, 'no re-login needed');
  assert.equal(await adminOk(r.cookie), true);
  const s = (await json('GET', '/api/admin/settings', null, pw)).body;
  assert.deepEqual(s.admin_emails, ['newadmin@example.com', 'other@x.io']);
  assert.deepEqual(s.admin_emails_config, ['boss@example.com']);
  assert.deepEqual(Object.keys(s.oauth).sort(), ['discord', 'github', 'google']);
  assert.match(s.oauth.google.callback_url, /\/auth\/google\/callback$/);

  assert.equal((await json('PUT', '/api/admin/settings', { admin_emails: 'not-an-email' }, pw)).status, 400);
  await json('PUT', '/api/admin/settings', { admin_emails: '' }, pw);
  assert.equal(await adminOk(r.cookie), false, 'removed => access gone on the very next request');
  // the config-file admin can never be removed from the UI
  assert.equal(await adminOk((await login('google', google('boss@example.com'))).cookie), true);
});

test('password login still works as the fallback, and sign-out clears both cookies', async () => {
  const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  const pw = res.headers.get('set-cookie').split(';')[0];
  assert.equal(await adminOk(pw), true);
  assert.equal((await json('GET', '/api/admin/me', null, pw)).body.via, 'password');
  const out = await fetch(base + '/api/auth/logout', { method: 'POST' });
  const cleared = out.headers.getSetCookie().join(' ');
  assert.match(cleared, /lx_admin=;/); assert.match(cleared, /lx_user=;/);
});

test('CSRF and tampering: bad/missing state, other provider, denied, forged cookie', async () => {
  // state mismatch
  nextProfile = google('boss@example.com');
  const start = await raw('/auth/google');
  const oauth = 'lx_oauth=' + cookiesOf(start).lx_oauth;
  const bad = await raw('/auth/google/callback?code=code-0&state=WRONG', oauth);
  assert.equal(bad.headers.get('location'), '/login?error=state');
  assert.ok(!cookiesOf(bad).lx_user);
  // no cookie at all (callback opened out of the blue)
  assert.equal((await raw('/auth/google/callback?code=x&state=y')).headers.get('location'), '/login?error=state');
  // a state cookie issued for google can't complete a github callback
  assert.equal((await raw('/auth/github/callback?code=x&state=y', oauth)).headers.get('location'), '/login?error=state');
  // user pressed "cancel" at the provider
  const st = new URL((await fetch(start.headers.get('location'), { redirect: 'manual' })).headers.get('location')).searchParams.get('state');
  assert.equal((await raw(`/auth/google/callback?error=access_denied&state=${st}`, oauth)).headers.get('location'), '/login?error=denied');
  // forged / altered session cookie
  const good = (await login('google', google('boss@example.com'))).cookie;
  const [pay, sig] = good.replace('lx_user=', '').split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pay, 'base64url')), emails: ['x@y.z', 'boss@example.com'] })).toString('base64url');
  assert.equal((await me(`lx_user=${forged}.${sig}`)).user, null);
  assert.equal(await adminOk(`lx_user=${pay}.AAAA`), false);
  // provider refuses the code
  const refused = await raw('/auth/google/callback?code=nope&state=' + st, oauth);
  assert.equal(refused.headers.get('location'), '/login?error=failed');
});

test('?next is limited to our own pages (no open redirect)', async () => {
  assert.equal((await login('google', google('a@b.co'), 'https://evil.example/phish')).location, '/');
  assert.equal((await login('google', google('a@b.co'), '//evil.example')).location, '/');
  assert.equal((await login('google', google('a@b.co'), '/admin')).location, '/admin');
});

test('auth start redirects to the provider with client id, our callback, scope and a state', async () => {
  const r = await raw('/auth/discord');
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.searchParams.get('client_id'), 'id-discord');
  assert.match(loc.searchParams.get('redirect_uri'), /\/auth\/discord\/callback$/);
  assert.ok(loc.searchParams.get('state').length >= 20);
  assert.equal(loc.searchParams.get('response_type'), 'code');
  const cookie = r.headers.getSetCookie().join(';');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  assert.equal((await raw('/auth/nonsense')).status, 404);
});
