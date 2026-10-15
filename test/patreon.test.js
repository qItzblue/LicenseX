import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signPatreon } from '../server/patreon.js';

// A fake GitHub (to sign in to LicenseX) and a fake Patreon (Connect Patreon), on one port.
let patron = null;            // what Patreon's identity endpoint answers
const mock = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (u.pathname.endsWith('/authorize')) return send(302, {}, { Location: `${u.searchParams.get('redirect_uri')}?code=c1&state=${u.searchParams.get('state')}` });
  let b = ''; req.on('data', d => b += d);
  req.on('end', () => {
    if (u.pathname === '/github/token') return send(200, { access_token: 't' });
    if (u.pathname === '/github/user') return send(200, { id: 7, login: 'maker', name: 'Maker' });
    if (u.pathname === '/github/emails') return send(200, [{ email: 'maker@example.com', primary: true, verified: true }]);
    if (u.pathname === '/patreon/api/oauth2/token') {
      const f = new URLSearchParams(b);
      return f.get('client_secret') === 'psecret' ? send(200, { access_token: 'pt' }) : send(401, { error: 'invalid_client' });
    }
    if (u.pathname === '/patreon/api/oauth2/v2/identity') return send(200, patron);
    send(404, {});
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const M = `http://127.0.0.1:${mock.address().port}`;

process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-patreon-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_OAUTH_TEST_BASE = M;
process.env.LICENSEX_GITHUB_CLIENT_ID = 'id-github'; process.env.LICENSEX_GITHUB_CLIENT_SECRET = 'secret-github';
process.env.LICENSEX_PATREON_TEST_BASE = M + '/patreon';
process.env.LICENSEX_PATREON_CLIENT_ID = 'pid'; process.env.LICENSEX_PATREON_CLIENT_SECRET = 'psecret';
process.env.LICENSEX_PATREON_WEBHOOK_SECRET = 'whsec';
process.env.LICENSEX_PATREON_TIERS = 't-pro:pro, t-big:lifetime';
const { server } = await import('../server/index.js');
let base;
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => { server.close(); mock.close(); });

const cookiesOf = res => Object.fromEntries(res.headers.getSetCookie().map(c => c.split(';')[0].split(/=(.*)/s).slice(0, 2)));
const raw = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const json = (method, path, body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));
const day = 86400, nowS = () => Math.floor(Date.now() / 1000), iso = s => new Date(s * 1000).toISOString();
const member = (userId, { email = '', status = 'active_patron', charge = 'Paid', next = nowS() + 30 * day, tiers = ['t-pro'] } = {}) => ({
  type: 'member', id: 'm-' + userId, attributes: { email, patron_status: status, last_charge_status: charge, last_charge_date: iso(nowS()), next_charge_date: next ? iso(next) : null },
  relationships: { user: { data: { id: userId, type: 'user' } }, currently_entitled_tiers: { data: tiers.map(id => ({ id, type: 'tier' })) } } });
const hook = (data, secret = 'whsec') => {
  const body = JSON.stringify({ data, included: [] });
  return fetch(base + '/api/patreon/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Patreon-Event': 'members:pledge:update', 'X-Patreon-Signature': signPatreon(body, secret) }, body });
};
async function signIn() {
  const start = await raw('/auth/github');
  const at = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const loc = new URL(at.headers.get('location'));
  const cb = await raw(loc.pathname + loc.search, 'lx_oauth=' + cookiesOf(start).lx_oauth);
  return 'lx_user=' + cookiesOf(cb).lx_user;
}
async function connectPatreon(cookie) {
  const start = await raw('/auth/patreon', cookie);
  assert.equal(start.status, 302);
  const at = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const loc = new URL(at.headers.get('location'));
  const cb = await raw(loc.pathname + loc.search, `${cookie}; lx_patreon=${cookiesOf(start).lx_patreon}`);
  return cb.headers.get('location');
}
const plan = async cookie => (await json('GET', '/api/workspace', null, cookie)).body;

test('Patreon payments switch the plan on and renew it, through Connect Patreon (emails may differ)', async () => {
  const cookie = await signIn();
  assert.equal((await json('POST', '/api/workspace/ensure', {}, cookie)).status, 201);
  assert.equal((await json('GET', '/api/billing/patreon', null, cookie)).body.linked, null);

  // forged and unsigned webhooks are refused
  assert.equal((await hook(member('p1'), 'wrong')).status, 401);

  // connecting a Patreon account that pays, with a different email
  patron = { data: { id: 'p1', type: 'user', attributes: { email: 'someone.else@patreon.example' } }, included: [member('p1')] };
  assert.match(await connectPatreon(cookie), /patreon=active#billing$/);
  let w = await plan(cookie);
  assert.equal(w.plan.key, 'pro');
  const first = w.plan_until;
  assert.ok(first > nowS() + 29 * day);

  // next month Patreon charges again: the plan runs on by itself
  assert.equal((await hook(member('p1', { next: nowS() + 61 * day }))).status, 200);
  w = await plan(cookie);
  assert.ok(w.plan_until > first + 29 * day, 'renewed');
  const renewed = w.plan_until;

  // a declined charge or cancelling never cuts the paid time short
  await hook(member('p1', { charge: 'Declined' }));
  await hook(member('p1', { status: 'former_patron', next: null }));
  assert.equal((await plan(cookie)).plan_until, renewed);
  assert.equal((await json('GET', '/api/billing/patreon', null, cookie)).body.linked.active, false);
});

test('a patron whose Patreon email is their sign-in email is linked automatically', async () => {
  // someone already signed in once with maker@example.com in the first test; a different Patreon account with that email
  const cookie = await signIn();
  await json('POST', '/api/billing/patreon/disconnect', {}, cookie);
  await hook(member('p2', { email: 'Maker@Example.com', next: nowS() + 90 * day }));
  const w = await plan(cookie);
  assert.ok(w.plan_until > nowS() + 89 * day);
  // that Patreon account now belongs to this LicenseX account
  assert.equal((await json('GET', '/api/billing/patreon', null, cookie)).body.linked.email, 'maker@example.com');
});

test('each Patreon tier gives its own plan; a tier that is not listed gives nothing', async () => {
  const cookie = await signIn();
  await hook(member('p2', { email: 'maker@example.com', tiers: ['t-big'], next: nowS() + 120 * day }));
  let w = await plan(cookie);
  assert.equal(w.plan_key, 'lifetime');
  assert.ok(w.plan_until > nowS() + 119 * day, 'a monthly tier still has an end date');
  // an unknown tier: nothing changes
  await hook(member('p2', { email: 'maker@example.com', tiers: ['t-other'], next: nowS() + 200 * day }));
  w = await plan(cookie);
  assert.equal(w.plan_key, 'lifetime'); assert.ok(w.plan_until < nowS() + 199 * day);
});
