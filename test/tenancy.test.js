import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, oauthEnv, googleUser, signIn } from './helpers/oauth-mock.mjs';

const mock = await startMock();
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-tenancy-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_ADMIN_EMAILS = 'boss@example.com';
process.env.LICENSEX_SIGNUPS_PER_IP_HOUR = '1000';
Object.assign(process.env, oauthEnv(mock.base));
const { server } = await import('../server/index.js');
let base;
after(() => { server.close(); mock.close(); });

const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
const call = (method, path, body, cookie, headers = {}) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const upload = (id, cookie) => fetch(`${base}/api/admin/products/${id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'p.jar' }, body: plugin }).then(async r => ({ status: r.status, body: await r.json() }));
const formPost = (path, fields) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }).then(async r => ({ status: r.status, text: await r.text() }));

let boss, alice, bob;
before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  boss = await signIn(base, mock, googleUser('boss@example.com'));
  alice = await signIn(base, mock, googleUser('alice@devs.io'));
  bob = await signIn(base, mock, googleUser('bob@devs.io'));
  await call('POST', '/api/workspace/ensure', null, alice);
  await call('POST', '/api/workspace/ensure', null, bob);
});

test('a signed-in person gets exactly one private workspace on the Free plan', async () => {
  const carol = await signIn(base, mock, googleUser('carol@devs.io'));
  assert.equal((await call('GET', '/api/admin/stats', null, carol)).status, 401, 'no workspace yet, no admin API');
  const a = await call('POST', '/api/workspace/ensure', null, carol);
  assert.equal(a.status, 201);
  assert.equal(a.body.plan.key, 'free'); assert.equal(a.body.house, false);
  const b = await call('POST', '/api/workspace/ensure', null, carol);
  assert.equal(b.status, 200); assert.equal(b.body.id, a.body.id, 'second call returns the same workspace');
  assert.equal((await call('GET', '/api/admin/stats', null, carol)).status, 200);
  assert.equal((await call('POST', '/api/workspace/ensure', null, undefined)).status, 401);
  const nomail = await signIn(base, mock, googleUser('x@y.zz', { verified: false }));
  assert.equal((await call('POST', '/api/workspace/ensure', null, nomail)).status, 400, 'an unverified email cannot own a workspace');
});

test('customers see only their own licenses, products, groups and servers; ids from another workspace are 404', async () => {
  const gA = (await call('POST', '/api/admin/groups', { name: 'Pro', max_servers: 5, color: '#112233' }, alice)).status;
  assert.equal(gA, 201);
  const gB = (await call('POST', '/api/admin/groups', { name: 'Pro', max_servers: 2, color: '#445566' }, bob)).status;
  assert.equal(gB, 201, 'same group name in a different workspace is fine');
  const groupsA = (await call('GET', '/api/admin/groups', null, alice)).body, groupsB = (await call('GET', '/api/admin/groups', null, bob)).body;
  assert.equal(groupsA.length, 1); assert.equal(groupsB.length, 1); assert.notEqual(groupsA[0].id, groupsB[0].id);

  const licA = (await call('POST', '/api/admin/licenses', { owner: 'a-buyer', group_id: groupsA[0].id }, alice)).body;
  const licB = (await call('POST', '/api/admin/licenses', { owner: 'b-buyer' }, bob)).body;
  const prodA = (await call('POST', '/api/admin/products', { name: 'Alice Plugin' }, alice)).body;
  assert.equal((await upload(prodA.id, alice)).status, 200);

  assert.deepEqual((await call('GET', '/api/admin/licenses', null, alice)).body.map(l => l.key), [licA.key]);
  assert.deepEqual((await call('GET', '/api/admin/licenses', null, bob)).body.map(l => l.key), [licB.key]);
  assert.equal((await call('GET', '/api/admin/licenses?q=a-buyer', null, bob)).body.length, 0, 'search cannot reach across');
  assert.equal((await call('GET', '/api/admin/products', null, bob)).body.length, 0);

  // every by-id route refuses another workspace's ids
  for (const [m, path, body] of [
    ['GET', `/api/admin/licenses/${licA.id}`], ['PATCH', `/api/admin/licenses/${licA.id}`, { owner: 'hacked' }], ['DELETE', `/api/admin/licenses/${licA.id}`],
    ['PATCH', `/api/admin/products/${prodA.id}`, { name: 'hacked' }], ['DELETE', `/api/admin/products/${prodA.id}`], ['GET', `/api/admin/products/${prodA.id}/bbb-build`],
    ['PATCH', `/api/admin/groups/${groupsA[0].id}`, { name: 'x', max_servers: 1 }], ['DELETE', `/api/admin/groups/${groupsA[0].id}`],
  ]) assert.equal((await call(m, path, body, bob)).status, 404, `${m} ${path}`);
  assert.equal((await upload(prodA.id, bob)).status, 404, 'cannot upload into someone else\'s product');
  assert.equal((await call('GET', `/api/admin/licenses/${licA.id}`, null, alice)).body.owner, 'a-buyer', 'and nothing was changed');
  assert.equal((await call('GET', '/api/admin/groups', null, alice)).body.length, 1);

  // cannot attach another workspace's group
  assert.equal((await call('POST', '/api/admin/licenses', { owner: 'x', group_id: groupsA[0].id }, bob)).status, 400);
  assert.equal((await call('PATCH', `/api/admin/licenses/${licB.id}`, { group_id: groupsA[0].id }, bob)).status, 400);
  assert.equal((await call('POST', '/api/admin/products', { name: 'x', group_id: groupsA[0].id }, bob)).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { bbb_group_id: groupsA[0].id }, bob)).status, 400);

  // servers
  const reg = (key, id) => call('POST', '/api/v1/validate', { key, instanceId: id, name: 'S ' + id, port: 25565 });
  assert.ok((await reg(licA.key, 'a1')).body.ok); assert.ok((await reg(licB.key, 'b1')).body.ok);
  const sA = (await call('GET', '/api/admin/servers', null, alice)).body, sB = (await call('GET', '/api/admin/servers', null, bob)).body;
  assert.equal(sA.length, 1); assert.equal(sB.length, 1); assert.equal(sA[0].license_key, licA.key);
  assert.equal((await call('PATCH', `/api/admin/servers/${sA[0].id}`, { status: 'disabled' }, bob)).status, 404);
  assert.equal((await call('DELETE', `/api/admin/servers/${sA[0].id}`, null, bob)).status, 404);
  assert.equal((await reg(licA.key, 'a1')).body.ok, true, 'alice\'s server untouched');

  // stats and audit are per workspace
  assert.equal((await call('GET', '/api/admin/stats', null, bob)).body.licenses, 1);
  const auditB = (await call('GET', '/api/admin/audit', null, bob)).body;
  assert.ok(auditB.length > 0);
  assert.ok(!auditB.some(a => a.target === licA.key || /Alice/.test(a.target + a.detail)), 'bob never sees alice\'s audit log');
});

test('BuiltByBit: each workspace has its own secret, and the same buyer id in two workspaces gets two separate licenses', async () => {
  const sA = (await call('GET', '/api/admin/settings', null, alice)).body.bbb_secret, sB = (await call('GET', '/api/admin/settings', null, bob)).body.bbb_secret;
  assert.ok(sA && sB && sA !== sB);
  assert.equal((await formPost('/api/v1/builtbybit/license', { secret: 'wrong-secret-wrong-secret', user_id: '5', resource_id: '9' })).status, 403);
  assert.equal((await formPost('/api/v1/builtbybit/license', { user_id: '5', resource_id: '9' })).status, 403);
  const a = await formPost('/api/v1/builtbybit/license', { secret: sA, user_id: '5', resource_id: '9' });
  const b = await formPost('/api/v1/builtbybit/license', { secret: sB, user_id: '5', resource_id: '9' });   // same BuiltByBit buyer, same resource id
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.notEqual(a.text, b.text, 'two developers must never share a buyer\'s license');
  assert.equal((await formPost('/api/v1/builtbybit/license', { secret: sA, user_id: '5', resource_id: '9' })).text, a.text, 'stable per workspace');
  assert.ok((await call('GET', '/api/admin/licenses?q=BuiltByBit', null, alice)).body.some(l => l.key === a.text));
  assert.ok(!(await call('GET', '/api/admin/licenses?q=BuiltByBit', null, alice)).body.some(l => l.key === b.text));
  assert.ok((await call('GET', '/api/admin/licenses?q=BuiltByBit', null, bob)).body.some(l => l.key === b.text));
  // rotating a secret only affects that workspace
  await call('PUT', '/api/admin/settings', { regenerate_bbb_secret: true }, alice);
  assert.equal((await formPost('/api/v1/builtbybit/license', { secret: sA, user_id: '5', resource_id: '9' })).status, 403);
  assert.equal((await formPost('/api/v1/builtbybit/license', { secret: sB, user_id: '5', resource_id: '9' })).status, 200);
});

test('a product download token only ever issues licenses in the product\'s own workspace', async () => {
  const p = (await call('POST', '/api/admin/products', { name: 'Bob Tool' }, bob)).body;
  assert.equal((await upload(p.id, bob)).status, 200);
  const before = (await call('GET', '/api/admin/licenses', null, alice)).body.length;
  const dl = await fetch(`${base}/download/${p.slug}?token=${p.token}&user=77`);
  assert.equal(dl.status, 200);
  assert.equal((await call('GET', '/api/admin/licenses', null, alice)).body.length, before, 'alice gained nothing');
  assert.ok((await call('GET', '/api/admin/licenses?q=77', null, bob)).body.length >= 1, 'the buyer\'s license is in bob\'s workspace');
  assert.equal((await fetch(`${base}/download/${p.slug}?token=${(await call('GET', '/api/admin/products', null, alice)).body[0]?.token}&user=77`)).status, 403, 'alice\'s token does not open bob\'s product');
});

test('customers cannot reach owner-only features, or pick another workspace', async () => {
  for (const [m, path, body] of [['GET', '/api/admin/customers'], ['GET', '/api/admin/plans'], ['POST', '/api/admin/plans', { key: 'x1', name: 'X' }],
    ['GET', '/api/admin/builds'], ['GET', '/api/admin/builds/tools'], ['GET', '/api/admin/backup'], ['POST', '/api/admin/restore', {}],
    ['POST', '/api/admin/customers', { email: 'x@y.zz' }], ['POST', '/api/admin/customers/2/plan', { plan_key: 'pro' }], ['POST', '/api/admin/customers/2/suspend', { suspended: true }], ['DELETE', '/api/admin/customers/2']])
    assert.equal((await call(m, path, body, alice)).status, 403, `${m} ${path}`);
  assert.equal((await call('PUT', '/api/admin/settings', { site_name: 'Pwned' }, alice)).status, 403);
  assert.equal((await call('PUT', '/api/admin/settings', { admin_emails: 'alice@devs.io' }, alice)).status, 403);
  const s = (await call('GET', '/api/admin/settings', null, alice)).body;
  assert.equal(s.role, 'tenant'); assert.ok(!('oauth' in s) && !('admin_emails' in s) && !('stripe' in s), 'no platform settings leak');
  assert.equal((await call('GET', '/api/public/site')).body.site_name, 'LicenseX');
  // the workspace header/param is ignored for customers
  const bobLic = (await call('GET', '/api/admin/licenses', null, bob)).body.map(l => l.key);
  const viaHeader = (await call('GET', '/api/admin/licenses', null, alice, { 'X-Workspace': '3' })).body.map(l => l.key);
  const viaParam = (await call('GET', '/api/admin/licenses?ws=3', null, alice)).body.map(l => l.key);
  for (const list of [viaHeader, viaParam]) assert.ok(!list.some(k => bobLic.includes(k)), 'still alice\'s data');
  assert.equal((await call('GET', '/api/admin/me', null, alice)).body.role, 'tenant');
  // an anonymous caller gets nothing
  assert.equal((await call('GET', '/api/admin/licenses')).status, 401);
  assert.equal((await call('GET', '/api/workspace')).status, 401);
});

test('the owner can see every customer and switch into any workspace', async () => {
  const customers = (await call('GET', '/api/admin/customers', null, boss)).body;
  assert.ok(customers.some(c => c.owner_email === 'alice@devs.io') && customers.some(c => c.owner_email === 'bob@devs.io'));
  assert.ok(customers.every(c => !('bbb_secret' in c)));
  const me = (await call('GET', '/api/admin/me', null, boss)).body;
  assert.equal(me.role, 'platform'); assert.equal(me.workspace.house, true);
  const bobWs = customers.find(c => c.owner_email === 'bob@devs.io').id;
  const asBob = (await call('GET', '/api/admin/licenses', null, boss, { 'X-Workspace': String(bobWs) })).body;
  const bobOwn = (await call('GET', '/api/admin/licenses', null, bob)).body;
  assert.deepEqual(asBob.map(l => l.key).sort(), bobOwn.map(l => l.key).sort());
  assert.equal((await call('GET', `/api/admin/licenses?ws=${bobWs}`, null, boss)).body.length, bobOwn.length);
  assert.equal((await call('GET', '/api/admin/licenses', null, boss)).body.some(l => bobOwn.some(o => o.key === l.key)), false, 'default view is the owner\'s own workspace');
  assert.equal((await call('GET', '/api/admin/me', null, boss, { 'X-Workspace': '99999' })).body.workspace.house, true, 'unknown workspace falls back safely');
});

test('plan limits stop new products and licenses, for dashboard, downloads and BuiltByBit alike; the owner is never limited', async () => {
  const dave = await signIn(base, mock, googleUser('dave@devs.io'));
  const ws = (await call('POST', '/api/workspace/ensure', null, dave)).body;
  await call('PATCH', '/api/admin/plans/free', { name: 'Free', max_products: 1, max_licenses: 3, price_cents: 0, interval: 'free' }, boss);
  const p1 = await call('POST', '/api/admin/products', { name: 'One' }, dave);
  assert.equal(p1.status, 201);
  const p2 = await call('POST', '/api/admin/products', { name: 'Two' }, dave);
  assert.equal(p2.status, 402); assert.equal(p2.body.code, 'PLAN_LIMIT'); assert.match(p2.body.message, /Free plan allows up to 1 plugin/);
  await upload(p1.body.id, dave);
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/admin/licenses', { owner: 'n' + i }, dave)).status, 201);
  const over = await call('POST', '/api/admin/licenses', { owner: 'one too many' }, dave);
  assert.equal(over.status, 402); assert.match(over.body.message, /up to 3 licenses/);
  assert.equal((await fetch(`${base}/download/${p1.body.slug}?token=${p1.body.token}&user=1`)).status, 402, 'download cannot mint past the limit');
  const secret = (await call('GET', '/api/admin/settings', null, dave)).body.bbb_secret;
  const bbb = await formPost('/api/v1/builtbybit/license', { secret, user_id: '1', resource_id: '1' });
  assert.equal(bbb.status, 402); assert.match(bbb.text, /3 licenses/);
  const usage = (await call('GET', '/api/workspace', null, dave)).body;
  assert.deepEqual(usage.usage, { licenses: 3, products: 1 });

  // the owner upgrades them by hand: limits lift immediately
  assert.equal((await call('POST', `/api/admin/customers/${ws.id}/plan`, { plan_key: 'pro', until: null }, boss)).status, 200);
  assert.equal((await call('POST', '/api/admin/licenses', { owner: 'now ok' }, dave)).status, 201);
  assert.equal((await call('POST', '/api/admin/products', { name: 'Two' }, dave)).status, 201);

  // the owner's own workspace ignores plan limits
  for (let i = 0; i < 6; i++) assert.equal((await call('POST', '/api/admin/licenses', { owner: 'house' + i }, boss)).status, 201);
  await call('PATCH', '/api/admin/plans/free', { name: 'Free', max_products: 1, max_licenses: 25, price_cents: 0, interval: 'free' }, boss);
});

test('a lapsed paid plan stops new things but NEVER switches off existing licenses', async () => {
  const erin = await signIn(base, mock, googleUser('erin@devs.io'));
  const ws = (await call('POST', '/api/workspace/ensure', null, erin)).body;
  const lic = (await call('POST', '/api/admin/licenses', { owner: 'buyer' }, erin)).body;
  const past = Math.floor(Date.now() / 1000) - 30 * 86400;
  await call('POST', `/api/admin/customers/${ws.id}/plan`, { plan_key: 'pro', until: past }, boss);
  const summary = (await call('GET', '/api/workspace', null, erin)).body;
  assert.equal(summary.lapsed, true); assert.equal(summary.plan.key, 'free');
  assert.equal((await call('POST', '/api/v1/validate', { key: lic.key, instanceId: 'e1' })).body.ok, true, 'buyers keep working');
  const future = Math.floor(Date.now() / 1000) + 30 * 86400;
  await call('POST', `/api/admin/customers/${ws.id}/plan`, { plan_key: 'pro', until: future }, boss);
  assert.equal((await call('GET', '/api/workspace', null, erin)).body.plan.key, 'pro');
  assert.equal((await call('POST', `/api/admin/customers/${ws.id}/plan`, { plan_key: 'nope' }, boss)).status, 400);
  assert.equal((await call('POST', '/api/admin/customers/1/plan', { plan_key: 'pro' }, boss)).status, 400, 'the owner workspace cannot be given a plan');
});

test('settings are per workspace: heartbeat and default server limit', async () => {
  const la = (await call('POST', '/api/admin/licenses', { owner: 'hb' }, alice)).body, lb = (await call('POST', '/api/admin/licenses', { owner: 'hb' }, bob)).body;
  await call('PUT', '/api/admin/settings', { heartbeat_minutes: 7, default_limit: 4 }, alice);
  assert.equal((await call('POST', '/api/v1/validate', { key: la.key, instanceId: 'hb1' })).body.heartbeat_minutes, 7);
  assert.equal((await call('POST', '/api/v1/validate', { key: lb.key, instanceId: 'hb1' })).body.heartbeat_minutes, 1, 'bob unaffected');
  assert.equal((await call('GET', '/api/admin/settings', null, bob)).body.heartbeat_minutes, '1');
  assert.equal((await call('GET', `/api/admin/licenses/${la.id}`, null, alice)).body.limit, 4);
});

test('suspending a customer blocks their licenses and edits, and unsuspending restores them', async () => {
  const frank = await signIn(base, mock, googleUser('frank@devs.io'));
  const ws = (await call('POST', '/api/workspace/ensure', null, frank)).body;
  const lic = (await call('POST', '/api/admin/licenses', { owner: 'f' }, frank)).body;
  const prod = (await call('POST', '/api/admin/products', { name: 'F plugin' }, frank)).body;
  await upload(prod.id, frank);
  assert.ok((await call('POST', '/api/v1/validate', { key: lic.key, instanceId: 'f1' })).body.ok);
  await call('POST', `/api/admin/customers/${ws.id}/suspend`, { suspended: true, reason: 'Terms violation' }, boss);
  const v = await call('POST', '/api/v1/validate', { key: lic.key, instanceId: 'f1' });
  assert.equal(v.body.code, 'LICENSE_BLOCKED'); assert.equal(v.body.message, 'Terms violation');
  assert.equal((await call('POST', '/api/public/lookup', { key: lic.key })).body.state, 'blocked');
  assert.equal((await call('POST', '/api/admin/licenses', { owner: 'x' }, frank)).status, 403, 'cannot create while suspended');
  assert.equal((await call('GET', '/api/admin/licenses', null, frank)).status, 200, 'can still read');
  assert.equal((await fetch(`${base}/download/${prod.slug}?token=${prod.token}&user=3`)).status, 403);
  await call('POST', `/api/admin/customers/${ws.id}/suspend`, { suspended: false }, boss);
  assert.ok((await call('POST', '/api/v1/validate', { key: lic.key, instanceId: 'f1' })).body.ok);
  assert.equal((await call('POST', '/api/admin/licenses', { owner: 'x' }, frank)).status, 201);
});

test('deleting a customer removes all of their data and nothing else', async () => {
  const gina = await signIn(base, mock, googleUser('gina@devs.io'));
  const ws = (await call('POST', '/api/workspace/ensure', null, gina)).body;
  const lic = (await call('POST', '/api/admin/licenses', { owner: 'g' }, gina)).body;
  await call('POST', '/api/admin/groups', { name: 'G', max_servers: 1 }, gina);
  const prod = (await call('POST', '/api/admin/products', { name: 'Gina plugin' }, gina)).body;
  await upload(prod.id, gina);
  const aliceBefore = (await call('GET', '/api/admin/licenses', null, alice)).body.length;
  assert.equal((await call('DELETE', `/api/admin/customers/${ws.id}`, null, boss)).status, 200);
  assert.equal((await call('POST', '/api/v1/validate', { key: lic.key, instanceId: 'x' })).body.code, 'INVALID_KEY');
  assert.equal((await fetch(`${base}/download/${prod.slug}?token=${prod.token}&user=1`)).status, 404);
  assert.equal((await call('GET', '/api/admin/stats', null, gina)).status, 401, 'her session no longer has a workspace');
  assert.equal((await call('GET', '/api/admin/licenses', null, alice)).body.length, aliceBefore);
  assert.equal((await call('DELETE', '/api/admin/customers/1', null, boss)).status, 400, 'the owner workspace cannot be deleted');
});

test('public pages leak no workspace internals', async () => {
  const lic = (await call('GET', '/api/admin/licenses', null, alice)).body[0];
  const view = (await call('POST', '/api/public/lookup', { key: lic.key })).body;
  const text = JSON.stringify(view);
  assert.ok(!/workspace|bbb|secret|owner_email/i.test(text), text);
  const pricing = (await call('GET', '/api/public/pricing')).body;
  assert.ok(pricing.plans.length >= 3 && pricing.plans.every(p => !('active' in p) && !('stripe_price_id' in p)));
  assert.equal(pricing.payments, false);
});
