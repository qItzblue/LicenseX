import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, oauthEnv, googleUser, signIn } from './helpers/oauth-mock.mjs';

// Signups closed: sign-in still works, but no one can create a workspace by themselves.
const mock = await startMock();
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-signups-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_ADMIN_EMAILS = 'boss@example.com';
process.env.LICENSEX_SIGNUPS = 'closed';
Object.assign(process.env, oauthEnv(mock.base));
const { server } = await import('../server/index.js');
let base, boss, guest;
after(() => { server.close(); mock.close(); });
const call = (method, path, body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  boss = await signIn(base, mock, googleUser('boss@example.com'));
  guest = await signIn(base, mock, googleUser('guest@devs.io'));
});

test('closed signups: strangers cannot create workspaces or check out', async () => {
  assert.equal((await call('GET', '/api/public/pricing')).body.signups, false);
  const r = await call('POST', '/api/workspace/ensure', null, guest);
  assert.equal(r.status, 403); assert.match(r.body.message, /closed/i);
  assert.equal((await call('GET', '/api/admin/stats', null, guest)).status, 401);
  assert.equal((await call('POST', '/api/billing/checkout', { plan: 'pro' }, guest)).status, 503, 'payments are off here, so checkout stops before it could create anything');
  assert.equal((await call('GET', '/api/admin/customers', null, boss)).body.filter(c => !c.house).length, 0, 'nothing was created');
});

test('the owner can invite someone: whoever signs in with that verified email owns the workspace', async () => {
  assert.equal((await call('POST', '/api/admin/customers', { email: 'nope' }, boss)).status, 400);
  assert.equal((await call('POST', '/api/admin/customers', { email: 'friend@devs.io', plan_key: 'nonexistent' }, boss)).status, 400);
  assert.equal((await call('POST', '/api/admin/customers', { email: 'friend@devs.io', name: 'Friend', plan_key: 'pro' }, guest)).status, 401, 'someone without an account cannot invite');
  const c = await call('POST', '/api/admin/customers', { email: 'Friend@Devs.io', name: 'Friend', plan_key: 'pro' }, boss);
  assert.equal(c.status, 201); assert.equal(c.body.plan.key, 'pro'); assert.equal(c.body.plan_source, 'manual'); assert.equal(c.body.owner_email, 'friend@devs.io');
  assert.equal((await call('POST', '/api/admin/customers', { email: 'friend@devs.io' }, boss)).status, 409);
  // a stranger who is NOT that email still cannot get in
  assert.equal((await call('GET', '/api/admin/stats', null, guest)).status, 401);
  // the invited person signs in and has the account, with the plan, despite closed signups
  const friend = await signIn(base, mock, googleUser('friend@devs.io'));
  assert.equal((await call('GET', '/api/admin/stats', null, friend)).status, 200);
  assert.equal((await call('POST', '/api/workspace/ensure', null, friend)).status, 200);
  assert.equal((await call('GET', '/api/workspace', null, friend)).body.plan.key, 'pro');
  assert.equal((await call('POST', '/api/admin/licenses', { owner: 'x' }, friend)).status, 201);
  // an UNVERIFIED claim to that email gets nothing
  const fake = await signIn(base, mock, googleUser('friend@devs.io', { verified: false }));
  assert.equal((await call('GET', '/api/admin/stats', null, fake)).status, 401);
});
