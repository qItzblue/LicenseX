import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, oauthEnv, googleUser, signIn } from './helpers/oauth-mock.mjs';
import { openDb, DatabaseSync } from '../server/db.js';
import { createBackup, restoreBackup } from '../server/backup.js';

// LicenseX's own plans are bought on BuiltByBit: one monthly, one one-time. The buyer downloads a file there, which carries an
// access key (a license in the owner's workspace); pasting it under Billing switches the plan on.
const mock = await startMock();
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-plansales-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_ADMIN_EMAILS = 'boss@example.com';
process.env.LICENSEX_SIGNUPS_PER_IP_HOUR = '1000';
Object.assign(process.env, oauthEnv(mock.base));
const { server } = await import('../server/index.js');
let base, boss, secret;
after(() => { server.close(); mock.close(); });
const call = (method, path, body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const login = email => signIn(base, mock, googleUser(email));
const DAY = 86400, nowSec = () => Math.floor(Date.now() / 1000);

/** What BuiltByBit does when a buyer downloads: asks for a key and writes the answer into the file. */
const bbbKey = (userId, resourceId) => fetch(`${base}/api/v1/builtbybit/license`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ secret, user_id: String(userId), resource_id: String(resourceId) }) }).then(r => r.text());
const redeem = (key, cookie) => call('POST', '/api/billing/redeem', { key }, cookie);
const workspace = async cookie => (await call('GET', '/api/workspace', null, cookie)).body;
const PRO = '7001', LIFETIME = '7002';

before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  boss = await login('boss@example.com');
  secret = (await call('GET', '/api/admin/settings', null, boss)).body.bbb_secret;
});

test('the owner sets where each plan is bought and which BuiltByBit resource hands out its keys', async () => {
  const plans = (await call('GET', '/api/admin/plans', null, boss)).body;
  const pro = plans.find(p => p.key === 'pro'), life = plans.find(p => p.key === 'lifetime');
  assert.equal(pro.interval, 'month'); assert.equal(life.interval, 'once');
  const patch = (p, extra) => call('PATCH', `/api/admin/plans/${p.key}`, { ...p, ...extra }, boss);
  assert.equal((await patch(pro, { buy_url: 'not a link' })).status, 400);
  assert.equal((await patch(pro, { buy_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await patch(pro, { bbb_resource_id: 'abc' })).status, 400);
  assert.equal((await patch(pro, { buy_url: 'https://builtbybit.com/resources/licensex-pro.7001/', bbb_resource_id: PRO })).status, 200);
  assert.equal((await patch(life, { bbb_resource_id: PRO })).status, 409, 'one plan per resource');
  assert.equal((await patch(life, { buy_url: 'https://builtbybit.com/resources/licensex-lifetime.7002/', bbb_resource_id: LIFETIME })).status, 200);
  const free = plans.find(p => p.key === 'free');
  assert.equal((await patch(free, { bbb_resource_id: '5' })).status, 400, 'the Free plan is not sold');
  const shown = (await call('GET', '/api/public/pricing')).body;
  assert.equal(shown.plans.find(p => p.key === 'pro').buy_url, 'https://builtbybit.com/resources/licensex-pro.7001/');
  assert.equal(shown.plans.find(p => p.key === 'free').buy_url, '');
  assert.ok(shown.plans.every(p => !('bbb_resource_id' in p)), 'the resource id is not published');
  assert.ok(!('payments' in shown) && !JSON.stringify(shown).toLowerCase().includes('stripe'));
});

test('BuiltByBit hands out access keys: stable per buyer, and a fresh one each month for the monthly plan', async () => {
  const life = await bbbKey(111, LIFETIME);
  assert.match(life, /^LX-/);
  assert.equal(await bbbKey(111, LIFETIME), life, 'downloading again gives the same key');
  assert.notEqual(await bbbKey(112, LIFETIME), life);
  const monthly = await bbbKey(111, PRO);
  assert.equal(await bbbKey(111, PRO), monthly, 'same month, same key');
  const kinds = (await call('GET', '/api/admin/licenses?q=BuiltByBit', null, boss)).body;
  const month = new Date().toISOString().slice(0, 7);
  assert.ok(kinds.some(l => l.key === monthly && l.product === `BuiltByBit resource ${PRO} ${month}`), 'a monthly key carries its month');
  assert.ok(kinds.some(l => l.key === life && l.product === `BuiltByBit resource ${LIFETIME}`), 'a one-time key has no period');
});

test('a one-time key switches the plan on for good, and only once', async () => {
  const alice = await login('alice@devs.io');
  await call('POST', '/api/workspace/ensure', null, alice);
  assert.equal((await workspace(alice)).plan_key, 'free');
  const key = await bbbKey(201, LIFETIME);
  const r = await redeem(key, alice);
  assert.equal(r.status, 200); assert.match(r.body.message, /Lifetime is active, with no end date/);
  const w = await workspace(alice);
  assert.equal(w.plan_key, 'lifetime'); assert.equal(w.plan_until, null); assert.equal(w.plan.key, 'lifetime'); assert.equal(w.lapsed, false);
  assert.match(w.plan_note, /^BuiltByBit key LX-/);
  assert.equal((await call('GET', '/api/public/pricing', null, alice)).body.current.plan_key, 'lifetime');
  // used up: nobody can use it again, including a different account
  assert.equal((await redeem(key, alice)).body.code, 'KEY_USED');
  const bob = await login('bob@devs.io');
  await call('POST', '/api/workspace/ensure', null, bob);
  const again = await redeem(key, bob);
  assert.equal(again.status, 409); assert.equal(again.body.code, 'KEY_USED');
  assert.equal((await workspace(bob)).plan_key, 'free', 'and bob got nothing');
  // the owner can see who used it
  const lic = (await call('GET', '/api/admin/licenses?q=' + key, null, boss)).body[0];
  const detail = (await call('GET', `/api/admin/licenses/${lic.id}`, null, boss)).body;
  assert.deepEqual([detail.redeemed.workspace, detail.redeemed.plan_key], ['alice', 'lifetime']);
  assert.ok(detail.redeemed.redeemed_at >= nowSec() - 60);
});

test('a monthly key adds 31 days, renewals stack, and a lifetime plan is never replaced by a monthly one', async () => {
  const bob = await login('bob@devs.io');
  const k1 = await bbbKey(301, PRO);
  const t0 = nowSec();
  const first = await redeem(k1, bob);
  assert.equal(first.status, 200);
  let w = await workspace(bob);
  assert.equal(w.plan_key, 'pro');
  assert.ok(Math.abs(w.plan_until - (t0 + 31 * DAY)) < 120, 'about a month from now');
  const until1 = w.plan_until;
  // the next month's key is a different license: using it adds another period on top of what is left
  const k2 = await bbbKey(302, PRO);
  assert.equal((await redeem(k2, bob)).status, 200);
  w = await workspace(bob);
  assert.equal(w.plan_until, until1 + 31 * DAY, 'renewing early does not waste the days that are left');
  assert.match(w.plan_note, /BuiltByBit key/);

  // someone on Lifetime cannot burn a monthly key: it is refused and stays usable
  const alice = await login('alice@devs.io');
  const k3 = await bbbKey(303, PRO);
  const refused = await redeem(k3, alice);
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'ALREADY_LIFETIME');
  assert.equal((await workspace(alice)).plan_key, 'lifetime');
  const carol = await login('carol@devs.io');
  assert.equal((await redeem(k3, carol)).status, 200, 'the refused key was not used up');
});

test('a monthly plan that is switched to a lifetime key becomes permanent', async () => {
  const dave = await login('dave@devs.io');
  await call('POST', '/api/workspace/ensure', null, dave);
  assert.equal((await redeem(await bbbKey(401, PRO), dave)).status, 200);
  assert.ok((await workspace(dave)).plan_until);
  assert.equal((await redeem(await bbbKey(402, LIFETIME), dave)).status, 200);
  const w = await workspace(dave);
  assert.equal(w.plan_key, 'lifetime'); assert.equal(w.plan_until, null);
});

test('only real access keys work, and every refusal reads the same', async () => {
  const eve = await login('eve@devs.io');
  await call('POST', '/api/workspace/ensure', null, eve);
  assert.equal((await call('POST', '/api/billing/redeem', { key: 'LX-AAAA-BBBB-CCCC-DDDD' })).status, 401, 'sign in first');
  const bad = [
    'nonsense', '', 'LX-AAAA-BBBB-CCCC-DDDD',
    (await call('POST', '/api/admin/licenses', { owner: 'x' }, boss)).body.key,                  // a license of the owner's, but not a plan key
    (await call('POST', '/api/admin/licenses', { owner: 'mine' }, eve)).body.key,                // a license in the customer's own workspace
    await bbbKey(501, '9999'),                                                                    // a BuiltByBit resource that is not a plan
  ];
  for (const key of bad) { const r = await redeem(key, eve); assert.equal(r.status, 404, `"${key}"`); assert.equal(r.body.code, 'BAD_KEY'); }
  assert.equal((await workspace(eve)).plan_key, 'free');

  // a cancelled key (refund) cannot be used
  const refunded = await bbbKey(502, LIFETIME);
  const lic = (await call('GET', '/api/admin/licenses?q=' + refunded, null, boss)).body[0];
  assert.equal((await call('PATCH', `/api/admin/licenses/${lic.id}`, { status: 'blocked', block_reason: 'refund' }, boss)).status, 200);
  const r = await redeem(refunded, eve);
  assert.equal(r.status, 403); assert.equal(r.body.code, 'KEY_REVOKED');
  assert.equal((await workspace(eve)).plan_key, 'free');
});

test('a first-time buyer gets an account together with the plan; guessing is rate limited', async () => {
  const frank = await login('frank@devs.io');
  assert.equal((await call('GET', '/api/admin/stats', null, frank)).status, 401, 'no workspace yet');
  assert.equal((await redeem('LX-AAAA-BBBB-CCCC-DDDD', frank)).status, 404);
  assert.equal((await call('GET', '/api/admin/stats', null, frank)).status, 401, 'a bad key creates nothing');
  const ok = await redeem(await bbbKey(601, LIFETIME), frank);
  assert.equal(ok.status, 200); assert.equal(ok.body.workspace.plan_key, 'lifetime');
  assert.equal((await call('GET', '/api/admin/stats', null, frank)).status, 200, 'now they have a workspace');

  const gina = await login('gina@devs.io');
  let last;
  for (let i = 0; i < 12; i++) last = await redeem('LX-AAAA-BBBB-CCCC-DDDD', gina);
  assert.equal(last.status, 429);
});

test('deleting a customer does not make their used key usable again, and backups keep the used keys', async () => {
  const hank = await login('hank@devs.io');
  const key = await bbbKey(701, LIFETIME);
  assert.equal((await redeem(key, hank)).status, 200);
  const id = (await call('GET', '/api/admin/customers', null, boss)).body.find(c => c.owner_email === 'hank@devs.io').id;
  assert.equal((await call('DELETE', `/api/admin/customers/${id}`, null, boss)).status, 200);
  const ivy = await login('ivy@devs.io');
  await call('POST', '/api/workspace/ensure', null, ivy);
  assert.equal((await redeem(key, ivy)).body.code, 'KEY_USED');

  // a backup carries the used-key list, so a restore cannot hand a key out twice
  const mk = () => { const dir = mkdtempSync(join(tmpdir(), 'lx-ps-bk-')); mkdirSync(join(dir, 'products')); return { products: join(dir, 'products'), db: openDb(join(dir, 'x.db')) }; };
  const a = mk();
  a.db.prepare("INSERT INTO licenses (workspace_id, key, owner, source, product, created_at) VALUES (1, 'LX-AAAA-BBBB-CCCC-DDDD', 'k', 'claim', 'BuiltByBit resource 1', 1)").run();
  const lid = a.db.prepare("SELECT id FROM licenses WHERE key = 'LX-AAAA-BBBB-CCCC-DDDD'").get().id;
  a.db.prepare("INSERT INTO plan_redemptions (license_id, workspace_id, plan_key, redeemed_at) VALUES (?, 1, 'lifetime', 5)").run(lid);
  const b = mk();
  restoreBackup(b.db, b.products, createBackup(a.db, a.products), DatabaseSync);
  assert.deepEqual(b.db.prepare('SELECT plan_key, redeemed_at FROM plan_redemptions').all().map(r => ({ ...r })), [{ plan_key: 'lifetime', redeemed_at: 5 }]);
});

test('Stripe is gone: no checkout, portal or webhook, and no card wording in the owner\'s settings', async () => {
  for (const [m, p] of [['POST', '/api/billing/checkout'], ['POST', '/api/billing/portal'], ['POST', '/api/stripe/webhook'], ['GET', '/api/admin/stripe']])
    assert.equal((await call(m, p, {}, boss)).status, 404, `${m} ${p}`);
  const settings = (await call('GET', '/api/admin/settings', null, boss)).body;
  assert.ok(!('stripe' in settings));
  const customers = (await call('GET', '/api/admin/customers', null, boss)).body;
  assert.ok(customers.every(c => !('stripe_customer_id' in c) && !('stripe_subscription_id' in c)));
});
