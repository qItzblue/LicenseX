import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, oauthEnv, googleUser, signIn } from './helpers/oauth-mock.mjs';
import { PERMISSIONS, cleanPermissions } from '../server/rbac.js';

// Roles, permissions and product-limited team members.
const mock = await startMock();
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-rbac-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_ADMIN_EMAILS = 'boss@example.com';
process.env.LICENSEX_SIGNUPS_PER_IP_HOUR = '1000';
process.env.TRUST_PROXY = '1';
Object.assign(process.env, oauthEnv(mock.base));
const { server, routes } = await import('../server/index.js');
let base;
after(() => { server.close(); mock.close(); });

const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
const call = (method, path, body, cookie, headers = {}) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const login = (email, opts) => signIn(base, mock, googleUser(email, opts));

let boss, alice, bob;           // site owner, two customers (each owns a workspace)
let prodA, prodB;               // alice's products
let roleIds;                    // alice's roles by name
const people = {};              // team members' cookies by name
let aliceWs, bobWs;

async function product(cookie, name) {
  const p = (await call('POST', '/api/admin/products', { name }, cookie)).body;
  const up = await fetch(`${base}/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'p.jar' }, body: plugin });
  assert.equal(up.status, 200);
  return p;
}
const team = async cookie => (await call('GET', '/api/admin/team', null, cookie)).body;
const addMember = (cookie, email, role_id, extra = {}) => call('POST', '/api/admin/team/members', { email, role_id, ...extra }, cookie);

before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  boss = await login('boss@example.com');
  alice = await login('alice@devs.io'); bob = await login('bob@devs.io');
  aliceWs = (await call('POST', '/api/workspace/ensure', null, alice)).body.id;
  bobWs = (await call('POST', '/api/workspace/ensure', null, bob)).body.id;
  await call('POST', `/api/admin/customers/${aliceWs}/plan`, { plan_key: 'pro' }, boss);
  await call('POST', `/api/admin/customers/${bobWs}/plan`, { plan_key: 'pro' }, boss);
  prodA = await product(alice, 'Plugin A'); prodB = await product(alice, 'Plugin B');
  const t = await team(alice); // opening the Team page creates the starter roles
  roleIds = Object.fromEntries(t.roles.map(r => [r.name, r.id]));
  // licenses: two for A (one with a server), one for B, one for nothing
  for (const [owner, pid] of [['a-one', prodA.id], ['a-two', prodA.id], ['b-one', prodB.id], ['loose', null]])
    assert.equal((await call('POST', '/api/admin/licenses', { owner, product_id: pid }, alice)).status, 201);
  const lics = (await call('GET', '/api/admin/licenses', null, alice)).body;
  for (const l of lics.filter(l => ['a-one', 'b-one'].includes(l.owner))) await call('POST', '/api/v1/validate', { key: l.key, instanceId: 'srv-' + l.owner, name: 'S ' + l.owner, port: 25565 });
});

// ---------------------------------------------------------------------------------------------------------------
test('the permission catalogue is consistent', () => {
  const keys = PERMISSIONS.map(p => p.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(cleanPermissions(['licenses.edit']), ['licenses.view', 'licenses.edit'], 'edit comes with view');
  assert.throws(() => cleanPermissions(['nope']), /Unknown permission/);
  assert.throws(() => cleanPermissions(['platform.site']), /only exists in the site owner/);
  assert.deepEqual(cleanPermissions(['platform.site'], { house: true }), ['platform.site']);
});

test('every admin route is guarded: no silent open doors', () => {
  const OPEN = new Set(['GET /api/admin/me', 'GET /api/admin/stats', 'GET /api/workspace']); // any signed-in team member; what they see is filtered inside
  const known = new Set(PERMISSIONS.map(p => p.key));
  for (const [method, re, , opts] of routes) {
    const path = re.source;
    if (!/^\^\\\/api\\\/(admin|workspace|billing)\\\//.test(path) && !/^\^\\\/api\\\/workspace\$/.test(path)) continue;
    if (/\\\/api\\\/admin\\\/(login|logout)\$/.test(path)) continue;
    if (/\\\/api\\\/(workspace\\\/ensure|billing\\\/(checkout|portal))\$/.test(path)) continue; // act for the signed-in OWNER only (checked in their handlers)
    const label = `${method} ${path}`;
    const guarded = opts.platform || opts.perm || (opts.admin && OPEN.has(`${method} ${path.replace(/\\\//g, '/').replace(/^\^|\$$/g, '')}`));
    assert.ok(guarded, `${label} has no permission guard`);
    for (const k of [].concat(opts.perm || [])) assert.ok(known.has(k), `${label} uses unknown permission ${k}`);
  }
});

test('a member with no permissions gets 403 on every guarded route, and anonymous callers 401', async () => {
  const t = await team(alice);
  const none = (await call('POST', '/api/admin/team/roles', { name: 'Nothing', permissions: [] }, alice)).body.id;
  assert.equal((await addMember(alice, 'nobody@devs.io', none)).status, 201);
  const nobody = await login('nobody@devs.io');
  let checked = 0;
  for (const [method, re, , opts] of routes) {
    if (!(opts.perm || opts.platform)) continue;
    const path = re.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\(\?<\w+>\[\^\/\]\+\)/g, '1');
    const anon = await call(method, path, {});
    assert.equal(anon.status, 401, `${method} ${path} anonymous`);
    const r = await call(method, path, {}, nobody);
    assert.equal(r.status, 403, `${method} ${path} with an empty role: ${JSON.stringify(r.body)}`);
    checked++;
  }
  assert.ok(checked > 25, `checked ${checked} routes`);
  assert.ok(t.roles.length >= 4);
});

// ---------------------------------------------------------------------------------------------------------------
test('starter roles exist, and who may do what follows the role', async () => {
  const t = await team(alice);
  assert.deepEqual(t.roles.map(r => r.name).filter(n => n !== 'Nothing').sort(), ['Administrator', 'Developer', 'Support', 'Viewer']);
  assert.equal(t.owner.email, 'alice@devs.io');
  assert.ok(t.permissions.every(p => !p.key.startsWith('platform.')), 'service-wide permissions are not offered in a customer workspace');

  assert.equal((await addMember(alice, 'sam@devs.io', roleIds.Support)).status, 201);
  assert.equal((await addMember(alice, 'vic@devs.io', roleIds.Viewer)).status, 201);
  people.sam = await login('sam@devs.io'); people.vic = await login('vic@devs.io');

  // Support: look, edit, block, manage servers; not create/delete/products/team/settings
  const sam = people.sam;
  const lic = (await call('GET', '/api/admin/licenses', null, sam)).body;
  assert.equal(lic.length, 4);
  const target = lic.find(l => l.owner === 'loose');
  assert.equal((await call('PATCH', `/api/admin/licenses/${target.id}`, { note: 'checked' }, sam)).status, 200);
  assert.equal((await call('PATCH', `/api/admin/licenses/${target.id}`, { status: 'blocked', block_reason: 'chargeback' }, sam)).status, 200);
  assert.equal((await call('PATCH', `/api/admin/licenses/${target.id}`, { status: 'active' }, sam)).status, 200);
  assert.equal((await call('POST', '/api/admin/licenses', { owner: 'x' }, sam)).status, 403);
  assert.equal((await call('DELETE', `/api/admin/licenses/${target.id}`, null, sam)).status, 403);
  assert.equal((await call('GET', '/api/admin/servers', null, sam)).body.length, 2);
  const srv = (await call('GET', '/api/admin/servers', null, sam)).body[0];
  assert.equal((await call('PATCH', `/api/admin/servers/${srv.id}`, { status: 'disabled' }, sam)).status, 200);
  assert.equal((await call('PATCH', `/api/admin/servers/${srv.id}`, { status: 'active' }, sam)).status, 200);
  assert.equal((await call('GET', '/api/admin/products', null, sam)).status, 200);
  assert.equal((await call('PATCH', `/api/admin/products/${prodA.id}`, { name: 'Hacked' }, sam)).status, 403);
  assert.equal((await call('POST', '/api/admin/products', { name: 'Mine' }, sam)).status, 403);
  assert.equal((await call('GET', '/api/admin/team', null, sam)).status, 403);
  assert.equal((await call('GET', '/api/admin/settings', null, sam)).status, 403, 'settings include the BuiltByBit secret');
  assert.equal((await call('GET', '/api/admin/audit', null, sam)).status, 403);

  // Viewer: read-only, and may see the activity log
  const vic = people.vic;
  assert.equal((await call('GET', '/api/admin/licenses', null, vic)).status, 200);
  assert.equal((await call('PATCH', `/api/admin/licenses/${target.id}`, { note: 'x' }, vic)).status, 403);
  assert.equal((await call('PATCH', `/api/admin/licenses/${target.id}`, { status: 'blocked' }, vic)).status, 403);
  assert.equal((await call('PATCH', `/api/admin/servers/${srv.id}`, { status: 'disabled' }, vic)).status, 403);
  assert.equal((await call('GET', '/api/admin/audit', null, vic)).status, 200);

  // the dashboard learns what to show
  const me = (await call('GET', '/api/admin/me', null, sam)).body;
  assert.equal(me.role, 'member'); assert.equal(me.member_role, 'Support'); assert.equal(me.limited, false);
  assert.ok(me.permissions.includes('licenses.block') && !me.permissions.includes('team.manage'));
  const mine = (await call('GET', '/api/auth/me', null, sam)).body.user;
  assert.equal(mine.workspace, null); assert.deepEqual(mine.memberships.map(m => [m.id, m.role]), [[aliceWs, 'Support']]);
});

test('the activity log names the person who acted', async () => {
  const audit = (await call('GET', '/api/admin/audit?limit=200', null, alice)).body;
  assert.ok(audit.some(a => a.action === 'license.block' && a.actor === 'sam@devs.io'));
  assert.ok(audit.some(a => a.action === 'member.add' && a.actor === 'alice@devs.io'));
});

// ---------------------------------------------------------------------------------------------------------------
test('a member limited to a product only ever sees and touches that product\'s licenses, servers and products', async () => {
  assert.equal((await addMember(alice, 'lee@devs.io', roleIds.Support, { all_products: false, product_ids: [prodA.id] })).status, 201);
  people.lee = await login('lee@devs.io');
  const lee = people.lee;
  const me = (await call('GET', '/api/admin/me', null, lee)).body;
  assert.equal(me.limited, true); assert.deepEqual(me.products, [prodA.id]);

  const lics = (await call('GET', '/api/admin/licenses', null, lee)).body;
  assert.deepEqual(lics.map(l => l.owner).sort(), ['a-one', 'a-two']);
  assert.ok(lics.every(l => l.product_id === prodA.id && l.product_name === 'Plugin A'));
  const all = (await call('GET', '/api/admin/licenses', null, alice)).body;
  const bLic = all.find(l => l.owner === 'b-one'), looseLic = all.find(l => l.owner === 'loose'), aLic = all.find(l => l.owner === 'a-one');
  for (const l of [bLic, looseLic]) {
    assert.equal((await call('GET', `/api/admin/licenses/${l.id}`, null, lee)).status, 404, `${l.owner} does not exist for them`);
    assert.equal((await call('PATCH', `/api/admin/licenses/${l.id}`, { note: 'x' }, lee)).status, 404);
    assert.equal((await call('PATCH', `/api/admin/licenses/${l.id}`, { status: 'blocked' }, lee)).status, 404);
    assert.equal((await call('DELETE', `/api/admin/licenses/${l.id}`, null, lee)).status, 403, 'Support has no delete permission');
  }
  assert.equal((await call('GET', `/api/admin/licenses/${aLic.id}`, null, lee)).body.servers.length, 1);
  // searching and filtering cannot reach outside
  assert.deepEqual((await call('GET', '/api/admin/licenses?q=b-one', null, lee)).body, []);
  assert.deepEqual((await call('GET', `/api/admin/licenses?product=${prodB.id}`, null, lee)).body, []);
  assert.deepEqual((await call('GET', '/api/admin/licenses?product=none', null, lee)).body, []);

  // servers
  assert.deepEqual((await call('GET', '/api/admin/servers', null, lee)).body.map(s => s.owner), ['a-one']);
  const bServer = (await call('GET', '/api/admin/servers', null, alice)).body.find(s => s.owner === 'b-one');
  assert.equal((await call('PATCH', `/api/admin/servers/${bServer.id}`, { status: 'disabled' }, lee)).status, 404);
  assert.equal((await call('DELETE', `/api/admin/servers/${bServer.id}`, null, lee)).status, 404);

  // products
  assert.deepEqual((await call('GET', '/api/admin/products', null, lee)).body.map(p => p.name), ['Plugin A']);

  // overview numbers count only their product; the activity log is not theirs to read
  const st = (await call('GET', '/api/admin/stats', null, lee)).body;
  assert.equal(st.licenses, 2); assert.equal(st.servers, 1); assert.deepEqual(st.recent, []);
  assert.equal((await call('GET', '/api/admin/audit', null, lee)).status, 403);
  assert.equal((await call('GET', '/api/admin/stats', null, alice)).body.licenses, 4);
});

test('a limited member can only create licenses for their own products and cannot move licenses out of them', async () => {
  const lee = people.lee;
  // Support has no create permission; give Lee a role that has it
  const maker = (await call('POST', '/api/admin/team/roles', { name: 'Licensing', permissions: ['licenses.create', 'licenses.edit', 'licenses.delete', 'groups.manage', 'team.manage', 'settings.manage', 'audit.view', 'products.create'] }, alice)).body.id;
  assert.equal((await call('PATCH', `/api/admin/team/members/${(await team(alice)).members.find(m => m.email === 'lee@devs.io').id}`, { role_id: maker }, alice)).status, 200);
  assert.equal((await call('POST', '/api/admin/licenses', { owner: 'no-product' }, lee)).status, 400, 'a product is required');
  assert.equal((await call('POST', '/api/admin/licenses', { owner: 'wrong', product_id: prodB.id }, lee)).status, 400);
  const mine = await call('POST', '/api/admin/licenses', { owner: 'lee-made', product_id: prodA.id, buyer_email: 'Buyer@Example.com' }, lee);
  assert.equal(mine.status, 201); assert.equal(mine.body.product_id, prodA.id); assert.equal(mine.body.buyer_email, 'buyer@example.com');
  assert.equal((await call('PATCH', `/api/admin/licenses/${mine.body.id}`, { product_id: prodB.id }, lee)).status, 400, 'cannot hand a license to a product they do not have');
  assert.equal((await call('PATCH', `/api/admin/licenses/${mine.body.id}`, { product_id: null }, lee)).status, 400, 'nor unlink it');
  assert.equal((await call('PATCH', `/api/admin/licenses/${mine.body.id}`, { buyer_email: 'not an email' }, lee)).status, 400);
  assert.equal((await call('DELETE', `/api/admin/licenses/${mine.body.id}`, null, lee)).status, 200);

  // permissions that reach across the workspace do not apply to someone limited to products, whatever their role says
  assert.equal((await call('GET', '/api/admin/team', null, lee)).status, 403);
  assert.equal((await call('GET', '/api/admin/settings', null, lee)).status, 403);
  assert.equal((await call('GET', '/api/admin/audit', null, lee)).status, 403);
  assert.equal((await call('POST', '/api/admin/groups', { name: 'g', max_servers: 1 }, lee)).status, 403);
  assert.equal((await call('POST', '/api/admin/products', { name: 'new' }, lee)).status, 403);
  const perms = (await call('GET', '/api/admin/me', null, lee)).body.permissions;
  assert.ok(!perms.includes('team.manage') && !perms.includes('settings.manage') && perms.includes('licenses.create'));
});

test('cleaning up unused download licenses only touches what the member may see', async () => {
  const lee = people.lee;
  // two never-used download licenses: one on A, one on B
  for (const [p, u] of [[prodA, 'x1'], [prodB, 'x2']]) assert.equal((await fetch(`${base}/download/${p.slug}?token=${p.token}&user=${u}`, { headers: { 'X-Forwarded-For': '10.1.1.' + u.slice(1) } })).status, 200);
  const dry = await call('POST', '/api/admin/licenses/purge-unused', { older_than_days: 0, dry_run: true }, lee);
  assert.equal(dry.body.count, 1, 'only the one on A');
  await call('POST', '/api/admin/licenses/purge-unused', { older_than_days: 0 }, lee);
  const owners = (await call('GET', '/api/admin/licenses', null, alice)).body.map(l => l.owner);
  assert.ok(!owners.includes('x1'), 'the unused license on A is gone');
  assert.ok(owners.includes('x2'), 'the one on B is untouched');
  assert.equal((await call('POST', '/api/admin/licenses/purge-unused', { older_than_days: 0, dry_run: true }, alice)).body.count, 1, 'and the owner can still clean it up');
});

test('licenses are linked to products when they are issued: downloads and BuiltByBit', async () => {
  // download link of product A -> linked to A
  await fetch(`${base}/download/${prodA.slug}?token=${prodA.token}&user=777`, { headers: { 'X-Forwarded-For': '10.2.0.1' } });
  const all = (await call('GET', '/api/admin/licenses', null, alice)).body;
  assert.equal(all.find(l => l.owner === '777').product_id, prodA.id);
  // BuiltByBit: before the product knows its resource id the license is unlinked...
  const secret = (await call('GET', '/api/admin/settings', null, alice)).body.bbb_secret;
  const bbb = (uid, rid) => fetch(`${base}/api/v1/builtbybit/license`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret, user_id: uid, resource_id: rid }) }).then(r => r.text());
  const key = await bbb('4242', '9001');
  assert.match(key, /^LX-/);
  const find = k => call('GET', `/api/admin/licenses?q=${k}`, null, alice).then(r => r.body[0]);
  assert.equal((await find(key)).product_id, null);
  assert.deepEqual((await call('GET', `/api/admin/licenses?q=${key}`, null, people.lee)).body, [], 'a limited member cannot see an unlinked license');
  // ...entering the resource id links the existing licenses and the next ones
  assert.equal((await call('PATCH', `/api/admin/products/${prodA.id}`, { bbb_resource_id: 'abc' }, alice)).status, 400);
  assert.equal((await call('PATCH', `/api/admin/products/${prodA.id}`, { bbb_resource_id: '9001' }, alice)).status, 200);
  assert.equal((await call('PATCH', `/api/admin/products/${prodB.id}`, { bbb_resource_id: '9001' }, alice)).status, 409, 'one product per resource');
  assert.equal((await find(key)).product_id, prodA.id);
  assert.equal((await call('GET', `/api/admin/licenses?q=${key}`, null, people.lee)).body.length, 1);
  const key2 = await bbb('4343', '9001');
  assert.equal((await find(key2)).product_id, prodA.id);
  assert.equal(await bbb('4242', '9001'), key, 'same buyer, same license');
});

// ---------------------------------------------------------------------------------------------------------------
test('only permissions you hold can be handed out, and nobody edits their own access', async () => {
  // Sam gets a role with team management but no ability to delete licenses
  const mgr = (await call('POST', '/api/admin/team/roles', { name: 'Team lead', permissions: ['team.manage', 'licenses.view', 'licenses.edit', 'servers.view'] }, alice)).body.id;
  assert.equal((await addMember(alice, 'tina@devs.io', mgr)).status, 201);
  people.tina = await login('tina@devs.io');
  const tina = people.tina;
  const t = await team(tina);
  assert.equal(t.permissions.find(p => p.key === 'licenses.view').held, true);
  assert.equal(t.permissions.find(p => p.key === 'licenses.delete').held, false);
  // she cannot create a role with delete, nor give anyone the Administrator role, nor change a more powerful person
  assert.equal((await call('POST', '/api/admin/team/roles', { name: 'Sneaky', permissions: ['licenses.delete'] }, tina)).status, 403);
  assert.equal((await addMember(tina, 'new@devs.io', roleIds.Administrator)).status, 403);
  const ok = await call('POST', '/api/admin/team/roles', { name: 'Looker', permissions: ['licenses.view'] }, tina);
  assert.equal(ok.status, 201);
  assert.equal((await addMember(tina, 'new@devs.io', ok.body.id)).status, 201);
  const members = (await team(tina)).members;
  const sam = members.find(m => m.email === 'sam@devs.io'), self = members.find(m => m.email === 'tina@devs.io');
  assert.equal(sam.editable, false, 'Support has block/manage permissions Tina lacks');
  assert.equal((await call('PATCH', `/api/admin/team/members/${sam.id}`, { disabled: true }, tina)).status, 403);
  assert.equal((await call('DELETE', `/api/admin/team/members/${sam.id}`, null, tina)).status, 403);
  assert.equal((await call('PATCH', `/api/admin/team/roles/${roleIds.Support}`, { permissions: [] }, tina)).status, 403);
  assert.equal((await call('DELETE', `/api/admin/team/roles/${roleIds.Support}`, null, tina)).status, 403);
  // not herself either: no changing own role or leaving
  assert.equal((await call('PATCH', `/api/admin/team/members/${self.id}`, { role_id: ok.body.id }, tina)).status, 403);
  assert.equal((await call('DELETE', `/api/admin/team/members/${self.id}`, null, tina)).status, 403);
  // the owner can do all of it
  assert.equal((await call('PATCH', `/api/admin/team/members/${self.id}`, { role_id: ok.body.id }, alice)).status, 200);
  assert.equal((await call('GET', '/api/admin/team', null, tina)).status, 403, 'and that took team management away from her');
});

test('roles and members: validation, duplicates, limits and clean-up', async () => {
  assert.equal((await call('POST', '/api/admin/team/roles', { name: '', permissions: [] }, alice)).status, 400);
  assert.equal((await call('POST', '/api/admin/team/roles', { name: 'Bad', permissions: ['licenses.fly'] }, alice)).status, 400);
  assert.equal((await call('POST', '/api/admin/team/roles', { name: 'Bad', permissions: ['platform.site'] }, alice)).status, 400, 'service-wide permissions do not exist here');
  assert.equal((await call('POST', '/api/admin/team/roles', { name: 'Support', permissions: [] }, alice)).status, 409);
  assert.equal((await call('POST', '/api/admin/team/roles', { name: 'Edit only', permissions: ['licenses.edit'] }, alice)).status, 201);
  const t = await team(alice);
  assert.deepEqual(t.roles.find(r => r.name === 'Edit only').permissions, ['licenses.view', 'licenses.edit'], 'what a permission needs is added');
  assert.equal((await addMember(alice, 'sam@devs.io', roleIds.Viewer)).status, 409, 'already on the team');
  assert.equal((await addMember(alice, 'SAM@devs.io ', roleIds.Viewer)).status, 409, 'email case does not matter');
  assert.equal((await addMember(alice, 'alice@devs.io', roleIds.Viewer)).status, 409, 'the owner is not a member');
  assert.equal((await addMember(alice, 'nope', roleIds.Viewer)).status, 400);
  assert.equal((await addMember(alice, 'x@devs.io', 999999)).status, 404);
  assert.equal((await addMember(alice, 'x@devs.io', roleIds.Viewer, { all_products: false, product_ids: [] })).status, 400, 'limited to nothing makes no sense');
  assert.equal((await addMember(alice, 'x@devs.io', roleIds.Viewer, { all_products: false, product_ids: [prodA.id, 99999] })).status, 400);
  // a role that is in use cannot be deleted
  assert.equal((await call('DELETE', `/api/admin/team/roles/${roleIds.Viewer}`, null, alice)).status, 409);
  // another workspace's roles, members and products do not exist for Alice
  await call('GET', '/api/admin/team', null, bob);
  const bobTeam = await team(bob);
  const bobRole = bobTeam.roles[0].id;
  assert.equal((await call('PATCH', `/api/admin/team/roles/${bobRole}`, { name: 'Mine now' }, alice)).status, 404);
  assert.equal((await addMember(alice, 'y@devs.io', bobRole)).status, 404);
  const bobProd = await product(bob, 'Bob plugin');
  assert.equal((await addMember(alice, 'y@devs.io', roleIds.Viewer, { all_products: false, product_ids: [bobProd.id] })).status, 400);
});

test('switching a member off or removing them takes effect immediately, and unverified emails never count', async () => {
  const lee = people.lee, sam = people.sam;
  const members = (await team(alice)).members;
  const samRow = members.find(m => m.email === 'sam@devs.io');
  assert.equal((await call('GET', '/api/admin/licenses', null, sam)).status, 200);
  assert.equal((await call('PATCH', `/api/admin/team/members/${samRow.id}`, { disabled: true }, alice)).status, 200);
  assert.equal((await call('GET', '/api/admin/licenses', null, sam)).status, 401, 'no access any more');
  assert.equal((await call('PATCH', `/api/admin/team/members/${samRow.id}`, { disabled: false }, alice)).status, 200);
  assert.equal((await call('GET', '/api/admin/licenses', null, sam)).status, 200);
  assert.equal((await call('DELETE', `/api/admin/team/members/${(await team(alice)).members.find(m => m.email === 'vic@devs.io').id}`, null, alice)).status, 200);
  assert.equal((await call('GET', '/api/admin/licenses', null, people.vic)).status, 401);
  // someone who merely CLAIMS lee's address (provider did not verify it) gets nothing
  const fake = await login('lee@devs.io', { verified: false });
  assert.equal((await call('GET', '/api/admin/licenses', null, fake)).status, 401);
  assert.equal((await call('GET', '/api/admin/licenses', null, lee)).status, 200);
});

test('a person on several teams picks one with X-Workspace and can never reach one they are not on', async () => {
  // Alice owns her workspace and is also a Viewer in Bob's
  const bobTeam = await team(bob);
  assert.equal((await addMember(bob, 'alice@devs.io', bobTeam.roles.find(r => r.name === 'Viewer').id)).status, 201);
  await call('POST', '/api/admin/licenses', { owner: 'bobs-license' }, bob);
  const own = (await call('GET', '/api/admin/licenses', null, alice)).body;
  assert.ok(!own.some(l => l.owner === 'bobs-license'), 'default is the workspace she owns');
  const asMember = (await call('GET', '/api/admin/licenses', null, alice, { 'X-Workspace': String(bobWs) })).body;
  assert.deepEqual(asMember.map(l => l.owner), ['bobs-license']);
  assert.equal((await call('POST', '/api/admin/licenses', { owner: 'nope' }, alice, { 'X-Workspace': String(bobWs) })).status, 403, 'a Viewer there cannot create');
  const me = (await call('GET', '/api/admin/me', null, alice, { 'X-Workspace': String(bobWs) })).body;
  assert.equal(me.role, 'member'); assert.equal(me.workspace.id, bobWs); assert.equal(me.workspaces.length, 2);
  // a workspace she is not part of is simply ignored
  const stranger = (await call('GET', '/api/admin/me', null, alice, { 'X-Workspace': '1' })).body;
  assert.equal(stranger.workspace.id, aliceWs);
  assert.equal((await call('GET', '/api/admin/licenses', null, alice, { 'X-Workspace': '1' })).body.some(l => l.owner === 'bobs-license'), false);
  // members of Alice's workspace cannot use the header to reach Bob's
  assert.equal((await call('GET', '/api/admin/licenses', null, people.sam, { 'X-Workspace': String(bobWs) })).body.some(l => l.owner === 'bobs-license'), false);
});

test('members never get owner-only powers, and a suspended workspace freezes them too', async () => {
  const sam = people.sam;
  for (const [m, p] of [['GET', '/api/admin/customers'], ['GET', '/api/admin/plans'], ['GET', '/api/admin/builds'], ['GET', '/api/admin/backup'], ['POST', '/api/admin/restore']])
    assert.equal((await call(m, p, null, sam)).status, 403, `${m} ${p}`);
  assert.equal((await call('POST', '/api/billing/portal', null, sam)).status, 401, 'billing belongs to the owner');
  await call('POST', `/api/admin/customers/${aliceWs}/suspend`, { suspended: true, reason: 'test' }, boss);
  const l = (await call('GET', '/api/admin/licenses', null, sam)).body.find(x => x.owner === 'loose');
  assert.equal((await call('PATCH', `/api/admin/licenses/${l.id}`, { note: 'nope' }, sam)).status, 403);
  assert.equal((await call('GET', '/api/admin/licenses', null, sam)).status, 200, 'reading still works');
  await call('POST', `/api/admin/customers/${aliceWs}/suspend`, { suspended: false }, boss);
});

test('staff of the site owner: service-wide permissions exist only in the owner\'s own workspace', async () => {
  const t = await team(boss);
  assert.ok(t.permissions.some(p => p.key === 'platform.customers'));
  const role = (await call('POST', '/api/admin/team/roles', { name: 'Customer care', permissions: ['platform.customers', 'licenses.view'] }, boss)).body.id;
  assert.equal((await addMember(boss, 'care@example.com', role)).status, 201);
  const care = await login('care@example.com');
  assert.equal((await call('GET', '/api/admin/customers', null, care)).status, 200);
  assert.equal((await call('POST', `/api/admin/customers/${bobWs}/suspend`, { suspended: false }, care)).status, 200);
  assert.equal((await call('DELETE', `/api/admin/customers/${bobWs}`, null, care)).status, 403, 'deleting a customer stays with the owner');
  assert.equal((await call('GET', '/api/admin/plans', null, care)).status, 403);
  assert.equal((await call('GET', '/api/admin/builds', null, care)).status, 403, 'running builds stays with the owner');
  assert.equal((await call('GET', '/api/admin/backup', null, care)).status, 403);
  assert.equal((await call('PUT', '/api/admin/settings', { admin_emails: 'care@example.com' }, care)).status, 403, 'nor can they make themselves an admin');
  assert.equal((await call('GET', '/api/admin/licenses', null, care, { 'X-Workspace': String(bobWs) })).body.some(l => l.owner === 'bobs-license'), false, 'staff cannot open customers\' workspaces');
});

test('deleting a customer removes their roles and team; a backup keeps roles, members and product limits', async () => {
  const { createBackup, restoreBackup, RestoreError } = await import('../server/backup.js');
  const { openDb, DatabaseSync } = await import('../server/db.js');
  const { mkdirSync } = await import('node:fs');
  // build a second database with a limited member and restore the backup of it elsewhere
  const mk = () => { const dir = mkdtempSync(join(tmpdir(), 'lx-rbac-bk-')); mkdirSync(join(dir, 'products')); return { dir, products: join(dir, 'products'), db: openDb(join(dir, 'x.db')) }; };
  const a = mk();
  a.db.prepare("INSERT INTO workspaces (name, owner_email, created_at) VALUES ('W', 'w@x.io', 1)").run();
  const ws = a.db.prepare("SELECT id FROM workspaces WHERE owner_email = 'w@x.io'").get().id;
  const pid = Number(a.db.prepare("INSERT INTO products (workspace_id, slug, name, token, created_at) VALUES (?, 'p', 'P', 't', 1)").run(ws).lastInsertRowid);
  const rid = Number(a.db.prepare("INSERT INTO roles (workspace_id, name, permissions, created_at) VALUES (?, 'R', '[\"licenses.view\"]', 1)").run(ws).lastInsertRowid);
  const mid = Number(a.db.prepare("INSERT INTO members (workspace_id, email, role_id, all_products, created_at) VALUES (?, 'm@x.io', ?, 0, 1)").run(ws, rid).lastInsertRowid);
  a.db.prepare('INSERT INTO member_products (member_id, product_id) VALUES (?, ?)').run(mid, pid);
  const zip = createBackup(a.db, a.products);
  const b = mk();
  restoreBackup(b.db, b.products, zip, DatabaseSync);
  assert.deepEqual(b.db.prepare('SELECT m.email, m.all_products, r.name role, (SELECT COUNT(*) FROM member_products WHERE member_id = m.id) n FROM members m JOIN roles r ON r.id = m.role_id').all().map(r => ({ ...r })), [{ email: 'm@x.io', all_products: 0, role: 'R', n: 1 }]);
  // a backup whose member points at a role that is not in it is refused
  a.db.exec('PRAGMA foreign_keys = OFF');
  a.db.prepare('DELETE FROM roles').run();
  const broken = createBackup(a.db, a.products);
  assert.throws(() => restoreBackup(mk().db, mk().products, broken, DatabaseSync), RestoreError);

  // deleting Bob's workspace removes his team too
  assert.equal((await call('DELETE', `/api/admin/customers/${bobWs}`, null, boss)).status, 200);
  assert.equal((await call('GET', '/api/admin/licenses', null, alice, { 'X-Workspace': String(bobWs) })).status, 200);
  assert.equal((await call('GET', '/api/admin/me', null, alice, { 'X-Workspace': String(bobWs) })).body.workspace.id, aliceWs, 'her membership there is gone');
});
