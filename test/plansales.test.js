import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, oauthEnv, googleUser, signIn } from './helpers/oauth-mock.mjs';
import { openDb, DatabaseSync } from '../server/db.js';
import { createBackup, restoreBackup } from '../server/backup.js';
import { createCore } from '../server/core.js';
import { issuePlanKey, periodTag, planForResource } from '../server/plansales.js';

// LicenseX's own plans are bought on BuiltByBit: one monthly, one one-time. The buyer downloads a file there, which carries an
// access key; pasting it under Billing switches the plan on. Access keys are not licenses and only the owner's plan-sales secret issues them.
const mock = await startMock();
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-plansales-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_ADMIN_EMAILS = 'boss@example.com';
process.env.LICENSEX_SIGNUPS_PER_IP_HOUR = '1000';
process.env.LICENSEX_MINT_PER_HOUR = '500';
process.env.TRUST_PROXY = '1';
Object.assign(process.env, oauthEnv(mock.base));
const { server } = await import('../server/index.js');
let base, boss, secret;
after(() => { server.close(); mock.close(); });
const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
const call = (method, path, body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const login = email => signIn(base, mock, googleUser(email));
const DAY = 86400, nowSec = () => Math.floor(Date.now() / 1000);

/** What BuiltByBit does when a buyer downloads: asks for a key and writes the answer into the file. */
const ask = (sec, userId, resourceId) => fetch(`${base}/api/v1/builtbybit/license`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ secret: sec, user_id: String(userId), resource_id: String(resourceId) }) }).then(async r => ({ status: r.status, text: await r.text() }));
const bbbKey = async (userId, resourceId) => { const r = await ask(secret, userId, resourceId); assert.equal(r.status, 200, r.text); return r.text; };
let ipSeq = 0;   // each request comes from its own address, so the per-address rate limit only matters where a test is about it
const redeem = (key, cookie, ip) => fetch(`${base}/api/billing/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), 'X-Forwarded-For': ip || `10.7.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}` }, body: JSON.stringify({ key }) })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const workspace = async cookie => (await call('GET', '/api/workspace', null, cookie)).body;
const PRO = '7001', LIFETIME = '7002';

before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  boss = await login('boss@example.com');
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
  assert.equal((await patch(plans.find(p => p.key === 'free'), { bbb_resource_id: '5' })).status, 400, 'the Free plan is not sold');
  const shown = (await call('GET', '/api/public/pricing')).body;
  assert.equal(shown.plans.find(p => p.key === 'pro').buy_url, 'https://builtbybit.com/resources/licensex-pro.7001/');
  assert.equal(shown.plans.find(p => p.key === 'free').buy_url, '');
  assert.ok(shown.plans.every(p => !('bbb_resource_id' in p)), 'the resource id is not published');
  assert.ok(!('payments' in shown) && !JSON.stringify(shown).toLowerCase().includes('stripe'));
  const sales = (await call('GET', '/api/admin/plan-sales', null, boss)).body;
  secret = sales.secret;
  assert.ok(secret.length >= 24 && sales.callback_url.endsWith('/api/v1/builtbybit/license'));
});

test('BuiltByBit hands out access keys: stable per buyer, a fresh one each month for the monthly plan', async () => {
  const life = await bbbKey(111, LIFETIME);
  assert.match(life, /^LX-/);
  assert.equal(await bbbKey(111, LIFETIME), life, 'downloading again gives the same key');
  assert.notEqual(await bbbKey(112, LIFETIME), life);
  const monthly = await bbbKey(111, PRO);
  assert.equal(await bbbKey(111, PRO), monthly, 'same month, same key');
  const list = (await call('GET', '/api/admin/plan-sales', null, boss)).body.keys;
  assert.ok(list.some(k => k.key === monthly && k.plan_key === 'pro' && k.period === new Date().toISOString().slice(0, 7)), 'a monthly key carries its month');
  assert.ok(list.some(k => k.key === life && k.plan_key === 'lifetime' && k.period === ''), 'a one-time key has no period');
  // the rules, with a clock we control
  const db = openDb(':memory:');
  const plan = { key: 'pro', interval: 'month', bbb_resource_id: PRO };
  const oct = issuePlanKey({ db, plan, user: '9', date: new Date('2026-10-31T23:59:00Z') }), nov = issuePlanKey({ db, plan, user: '9', date: new Date('2026-11-01T00:01:00Z') });
  assert.notEqual(oct, nov); assert.equal(issuePlanKey({ db, plan, user: '9', date: new Date('2026-10-02T00:00:00Z') }), oct);
  assert.equal(periodTag('year', new Date('2026-05-05T00:00:00Z')), '2026'); assert.equal(periodTag('once'), '');
  assert.equal(planForResource(db, '12345'), null);
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
  assert.match(w.plan_note, /^BuiltByBit key #\d+$/, 'the note carries no key');
  assert.equal((await call('GET', '/api/public/pricing', null, alice)).body.current.plan_key, 'lifetime');
  assert.equal((await redeem(key, alice)).body.code, 'KEY_USED');
  const bob = await login('bob@devs.io');
  await call('POST', '/api/workspace/ensure', null, bob);
  const again = await redeem(key, bob);
  assert.equal(again.status, 409); assert.equal(again.body.code, 'KEY_USED');
  assert.equal((await workspace(bob)).plan_key, 'free', 'and bob got nothing');
  const used = (await call('GET', '/api/admin/plan-sales', null, boss)).body.keys.find(k => k.key === key);
  assert.deepEqual([used.workspace, used.plan_key, !!used.redeemed_at], ['alice', 'lifetime', true], 'the owner sees who used it');
  assert.equal((await call('POST', `/api/admin/plan-keys/${used.id}/revoke`, {}, boss)).status, 409, 'a used key cannot be cancelled');
});

test('a monthly key adds 31 days, renewals stack, and an end-less plan is never replaced or burned', async () => {
  const bob = await login('bob@devs.io');
  const k1 = await bbbKey(301, PRO), t0 = nowSec();
  assert.equal((await redeem(k1, bob)).status, 200);
  let w = await workspace(bob);
  assert.equal(w.plan_key, 'pro');
  assert.ok(Math.abs(w.plan_until - (t0 + 31 * DAY)) < 120, 'about a month from now');
  const until1 = w.plan_until;
  assert.equal((await redeem(await bbbKey(302, PRO), bob)).status, 200);
  w = await workspace(bob);
  assert.equal(w.plan_until, until1 + 31 * DAY, 'renewing early does not waste the days that are left');

  // someone on Lifetime cannot burn a monthly key; neither can a second Lifetime key be burned
  const alice = await login('alice@devs.io');
  const k3 = await bbbKey(303, PRO);
  const refused = await redeem(k3, alice);
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'ALREADY_PERMANENT');
  assert.equal((await redeem(await bbbKey(304, LIFETIME), alice)).body.code, 'ALREADY_PERMANENT');
  assert.equal((await workspace(alice)).plan_key, 'lifetime');
  const carol = await login('carol@devs.io');
  assert.equal((await redeem(k3, carol)).status, 200, 'the refused key was not used up');

  // a plan the owner gave by hand without an end date is not turned into a 31-day plan by a key
  const dave = await login('dave@devs.io');
  const ws = (await call('POST', '/api/workspace/ensure', null, dave)).body.id;
  assert.equal((await call('POST', `/api/admin/customers/${ws}/plan`, { plan_key: 'pro' }, boss)).status, 200);
  const k4 = await bbbKey(305, PRO);
  assert.equal((await redeem(k4, dave)).body.code, 'ALREADY_PERMANENT');
  assert.equal((await workspace(dave)).plan_until, null, 'still no end date');
  // ...but a monthly plan can be upgraded to a lifetime one
  const erin = await login('erin@devs.io');
  await call('POST', '/api/workspace/ensure', null, erin);
  assert.equal((await redeem(await bbbKey(306, PRO), erin)).status, 200);
  assert.equal((await redeem(await bbbKey(307, LIFETIME), erin)).status, 200);
  const e = await workspace(erin);
  assert.equal(e.plan_key, 'lifetime'); assert.equal(e.plan_until, null);
});

test('only real access keys work, every refusal reads the same, and a refunded key is refused', async () => {
  const eve = await login('eve@devs.io');
  await call('POST', '/api/workspace/ensure', null, eve);
  assert.equal((await call('POST', '/api/billing/redeem', { key: 'LX-AAAA-BBBB-CCCC-DDDD' })).status, 401, 'sign in first');
  const bad = ['nonsense', '', 'LX-AAAA-BBBB-CCCC-DDDD',
    (await call('POST', '/api/admin/licenses', { owner: 'x' }, boss)).body.key,        // an ordinary license of the owner's
    (await call('POST', '/api/admin/licenses', { owner: 'mine' }, eve)).body.key];     // one in the customer's own workspace
  for (const key of bad) { const r = await redeem(key, eve); assert.equal(r.status, 404, `"${key}"`); assert.equal(r.body.code, 'BAD_KEY'); }
  assert.equal((await ask(secret, 501, '9999')).status, 404, 'a resource that is no plan gets no key');
  assert.equal((await ask(secret, 'abc', LIFETIME)).status, 400);
  assert.equal((await workspace(eve)).plan_key, 'free');

  const refunded = await bbbKey(502, LIFETIME);
  const row = (await call('GET', '/api/admin/plan-sales', null, boss)).body.keys.find(k => k.key === refunded);
  assert.equal((await call('POST', `/api/admin/plan-keys/${row.id}/revoke`, {}, boss)).status, 200);
  const r = await redeem(refunded, eve);
  assert.equal(r.status, 403); assert.equal(r.body.code, 'KEY_REVOKED');
  assert.equal(await bbbKey(502, LIFETIME), refunded, 'asking again does not give the refunded buyer a new key');
  assert.equal((await workspace(eve)).plan_key, 'free');
});

test('staff cannot print plan keys: not through product names, not through the workspace secret', async () => {
  // the owner gives two people stock/custom roles in the owner's own workspace
  const roles = (await call('GET', '/api/admin/team', null, boss)).body.roles;
  const webmaster = (await call('POST', '/api/admin/team/roles', { name: 'Webmaster', permissions: ['settings.manage'] }, boss)).body.id;
  assert.equal((await call('POST', '/api/admin/team/members', { email: 'dev@staff.io', role_id: roles.find(r => r.name === 'Developer').id }, boss)).status, 201);
  assert.equal((await call('POST', '/api/admin/team/members', { email: 'web@staff.io', role_id: webmaster }, boss)).status, 201);
  assert.equal((await call('POST', '/api/admin/team/members', { email: 'adm@staff.io', role_id: roles.find(r => r.name === 'Administrator').id }, boss)).status, 201);
  const dev = await login('dev@staff.io'), web = await login('web@staff.io'), adm = await login('adm@staff.io');

  // (a) a product named like a plan resource: downloads give ordinary licenses, which are no plan keys
  const p = (await call('POST', '/api/admin/products', { name: `BuiltByBit resource ${LIFETIME}` }, dev)).body;
  await fetch(`${base}/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: dev, 'X-Filename': 'p.jar' }, body: plugin });
  const dl = await fetch(`${base}/download/${p.slug}?token=${p.token}&user=424242`, { headers: { 'X-Forwarded-For': '10.0.0.1' } });
  assert.equal(dl.status, 200);
  const forged = (await call('GET', '/api/admin/licenses?q=424242', null, dev)).body[0].key;
  const victim = await login('victim@cust.io');
  await call('POST', '/api/workspace/ensure', null, victim);
  assert.equal((await redeem(forged, victim)).status, 404);

  // (b) the owner's ordinary BuiltByBit secret is visible to settings.manage; it never issues plan keys
  for (const who of [web, adm]) {
    const houseSecret = (await call('GET', '/api/admin/settings', null, who)).body.bbb_secret;
    assert.ok(houseSecret && houseSecret !== secret);
    const got = await ask(houseSecret, 777, LIFETIME);
    assert.equal(got.status, 200);
    assert.equal((await redeem(got.text, victim)).status, 404, 'an ordinary license, not an access key');
    assert.equal((await call('GET', '/api/admin/plan-sales', null, who)).status, 403, 'the plan-sales secret is not theirs to read');
    assert.equal((await call('POST', '/api/admin/plan-sales/secret', {}, who)).status, 403);
  }
  assert.equal((await workspace(victim)).plan_key, 'free');

  // access keys are not licenses: nobody can list, search, open or delete them through the license pages
  const key = await bbbKey(900, LIFETIME);
  for (const who of [dev, boss]) assert.deepEqual((await call('GET', `/api/admin/licenses?q=${key}`, null, who)).body, []);
  assert.equal((await call('POST', '/api/public/lookup', { key })).status, 404, 'and the public license page does not know them');
  assert.equal((await call('POST', '/api/v1/validate', { key, instanceId: 'x' })).body.code, 'INVALID_KEY', 'nor does a plugin accept them');
  // cleaning up unused licenses cannot take a key away
  assert.equal((await call('POST', '/api/admin/licenses/purge-unused', { older_than_days: 0 }, boss)).status, 200);
  const buyer = await login('buyer900@devs.io');
  await call('POST', '/api/workspace/ensure', null, buyer);
  assert.equal((await redeem(key, buyer)).status, 200);
});

test('a new secret cuts off the old one; a first-time buyer gets an account with the plan; guessing is rate limited', async () => {
  const before = secret;
  secret = (await call('POST', '/api/admin/plan-sales/secret', {}, boss)).body.secret;
  assert.notEqual(secret, before);
  assert.equal((await ask(before, 1, LIFETIME)).status, 403, 'the old secret no longer works');
  assert.equal((await ask(secret, 1, LIFETIME)).status, 200);

  const frank = await login('frank@devs.io');
  assert.equal((await call('GET', '/api/admin/stats', null, frank)).status, 401, 'no workspace yet');
  assert.equal((await redeem('LX-AAAA-BBBB-CCCC-DDDD', frank)).status, 404);
  assert.equal((await call('GET', '/api/admin/stats', null, frank)).status, 401, 'a bad key creates nothing');
  const ok = await redeem(await bbbKey(601, LIFETIME), frank);
  assert.equal(ok.status, 200); assert.equal(ok.body.workspace.plan_key, 'lifetime');
  assert.equal((await call('GET', '/api/admin/stats', null, frank)).status, 200, 'now they have a workspace');

  const gina = await login('gina@devs.io');
  let last;
  for (let i = 0; i < 12; i++) last = await redeem('LX-AAAA-BBBB-CCCC-DDDD', gina, '10.99.0.1');
  assert.equal(last.status, 429);
});

test('a used key stays used when its customer is deleted and across a backup and restore', async () => {
  const hank = await login('hank@devs.io');
  const key = await bbbKey(701, LIFETIME);
  assert.equal((await redeem(key, hank)).status, 200);
  const id = (await call('GET', '/api/admin/customers', null, boss)).body.find(c => c.owner_email === 'hank@devs.io').id;
  assert.equal((await call('DELETE', `/api/admin/customers/${id}`, null, boss)).status, 200);
  const ivy = await login('ivy@devs.io');
  await call('POST', '/api/workspace/ensure', null, ivy);
  assert.equal((await redeem(key, ivy)).body.code, 'KEY_USED');
  assert.equal((await ask(secret, 701, LIFETIME)).text, key, 'and the buyer who asks again just gets the same, used key');

  const mk = () => { const dir = mkdtempSync(join(tmpdir(), 'lx-ps-bk-')); mkdirSync(join(dir, 'products')); return { products: join(dir, 'products'), db: openDb(join(dir, 'x.db')) }; };
  const a = mk();
  a.db.prepare("INSERT INTO plan_keys (key, identity, plan_key, issued_at, redeemed_by, redeemed_at) VALUES ('LX-AAAA-BBBB-CCCC-DDDD', 'i1', 'lifetime', 1, 1, 5)").run();
  const b = mk();
  restoreBackup(b.db, b.products, createBackup(a.db, a.products), DatabaseSync);
  assert.deepEqual(b.db.prepare('SELECT plan_key, redeemed_by, redeemed_at FROM plan_keys').all().map(r => ({ ...r })), [{ plan_key: 'lifetime', redeemed_by: 1, redeemed_at: 5 }]);
  assert.ok(createCore(b.db), 'the restored database is usable');
});

test('team members of the owner see no plan details through /api/admin/me', async () => {
  const dev = await login('dev@staff.io');
  const me = (await call('GET', '/api/admin/me', null, dev)).body;
  assert.equal(me.workspace.plan, null);
  const owner = (await call('GET', '/api/admin/me', null, boss)).body;
  assert.ok(!('bbb_resource_id' in owner.workspace.plan) && !('buy_url' in owner.workspace.plan));
  const alice = await login('alice@devs.io');
  assert.ok(!('bbb_resource_id' in (await call('GET', '/api/admin/me', null, alice)).body.workspace.plan));
});

test('Stripe is gone: no checkout, portal or webhook, and no card wording in the owner\'s settings', async () => {
  for (const [m, p] of [['POST', '/api/billing/checkout'], ['POST', '/api/billing/portal'], ['POST', '/api/stripe/webhook'], ['GET', '/api/admin/stripe']])
    assert.equal((await call(m, p, {}, boss)).status, 404, `${m} ${p}`);
  assert.ok(!('stripe' in (await call('GET', '/api/admin/settings', null, boss)).body));
  const customers = (await call('GET', '/api/admin/customers', null, boss)).body;
  assert.ok(customers.every(c => !('stripe_customer_id' in c) && !('stripe_subscription_id' in c)));
});
