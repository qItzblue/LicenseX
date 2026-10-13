import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, oauthEnv, googleUser, signIn } from './helpers/oauth-mock.mjs';

// No Stripe keys at all: the site must still work, and say clearly that payments are off.
const mock = await startMock();
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-nostripe-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
for (const k of ['LICENSEX_STRIPE_SECRET_KEY', 'LICENSEX_STRIPE_WEBHOOK_SECRET']) delete process.env[k];
Object.assign(process.env, oauthEnv(mock.base));
const { server } = await import('../server/index.js');
let base, alice;
after(() => { server.close(); mock.close(); });
const call = (method, path, body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  alice = await signIn(base, mock, googleUser('alice@devs.io'));
});

test('payments off: pricing says so, checkout and portal explain, webhook is closed, free workspaces still work', async () => {
  assert.equal((await call('GET', '/api/public/pricing')).body.payments, false);
  await call('POST', '/api/workspace/ensure', null, alice);
  const co = await call('POST', '/api/billing/checkout', { plan: 'pro' }, alice);
  assert.equal(co.status, 503); assert.match(co.body.message, /not set up|contact/i);
  assert.equal((await call('POST', '/api/billing/portal', null, alice)).status, 400);
  assert.equal((await fetch(base + '/api/stripe/webhook', { method: 'POST', body: '{}' })).status, 503);
  assert.equal((await call('POST', '/api/admin/licenses', { owner: 'still works' }, alice)).status, 201);
  assert.equal((await call('GET', '/api/workspace', null, alice)).body.billing.stripe, false);
});
