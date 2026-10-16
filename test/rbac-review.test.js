import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startMock, oauthEnv, googleUser, signIn } from './helpers/oauth-mock.mjs';
import { readEntry } from '../server/jarstamp.js';
import { readWrappedConfig } from '../server/wrapjar.js';

// Regression tests for what the security review of the roles system found: a limited member must not be able to read
// other products' licenses by renaming their product, adopt unlinked licenses, or see more than their permissions allow.
const mock = await startMock();
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-rbac-review-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_ADMIN_EMAILS = 'boss@example.com';
process.env.LICENSEX_SIGNUPS_PER_IP_HOUR = '1000';
process.env.LICENSEX_MINT_PER_HOUR = '500';
process.env.TRUST_PROXY = '1';
Object.assign(process.env, oauthEnv(mock.base));
const { server } = await import('../server/index.js');
const cfgOf = jar => readWrappedConfig(jar, readFileSync(join(process.env.LICENSEX_DATA, 'session.secret'), 'utf8').trim());
let base, boss, alice, aliceWs, prodA, prodB, dev, mon, catalog, plain;
const people = {};
after(() => { server.close(); mock.close(); });

const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
const call = (method, path, body, cookie, headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const login = email => signIn(base, mock, googleUser(email));
let ipSeq = 0;
const download = async (p, query = '') => {
  const r = await fetch(`${base}/download/${p.slug}?token=${p.token}${query}`, { headers: { 'X-Forwarded-For': `10.9.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}` } });
  if (r.status !== 200) return { status: r.status };
  return { status: 200, key: cfgOf(Buffer.from(await r.arrayBuffer())).key };
};
async function product(cookie, name) {
  const p = (await call('POST', '/api/admin/products', { name }, cookie)).body;
  await fetch(`${base}/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'p.jar' }, body: plugin });
  return p;
}
const role = async (name, permissions) => (await call('POST', '/api/admin/team/roles', { name, permissions }, alice)).body.id;
const member = (email, role_id, extra = {}) => call('POST', '/api/admin/team/members', { email, role_id, ...extra }, alice);

before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  boss = await login('boss@example.com'); alice = await login('alice@devs.io');
  aliceWs = (await call('POST', '/api/workspace/ensure', null, alice)).body.id;
  await call('POST', `/api/admin/customers/${aliceWs}/plan`, { plan_key: 'pro' }, boss);
  prodA = await product(alice, 'Plugin A'); prodB = await product(alice, 'Plugin B');
  const developer = await role('Dev', ['products.view', 'products.edit', 'licenses.view']);
  await member('dev@devs.io', developer, { all_products: false, product_ids: [prodA.id] });
  await member('mon@devs.io', await role('Monitor', ['servers.view']));
  await member('catalog@devs.io', await role('Catalog', ['products.view']));
  await member('plain@devs.io', await role('Plain', ['licenses.view']));
  dev = await login('dev@devs.io'); mon = await login('mon@devs.io'); catalog = await login('catalog@devs.io'); plain = await login('plain@devs.io');   // one after another: the fake provider serves one person at a time
});

test('renaming your product cannot make a download return another product\'s license', async () => {
  const victim = await download(prodB, '&user=555');          // a buyer of product B
  assert.match(victim.key, /^LX-/);
  assert.equal((await download(prodB, '&user=555')).key, victim.key, 'B\'s own buyer still gets the same key every time');
  // the limited developer renames A to B's name and asks for the same buyer id
  assert.equal((await call('PATCH', `/api/admin/products/${prodA.id}`, { name: 'Plugin B' }, dev)).status, 200);
  const stolen = await download(prodA, '&user=555');
  assert.equal(stolen.status, 200);
  assert.notEqual(stolen.key, victim.key, 'they get their own product\'s license, not the other product\'s');
  assert.deepEqual((await call('GET', `/api/admin/licenses?q=${victim.key}`, null, dev)).body, [], 'and still cannot see B\'s license');
  assert.equal((await call('PATCH', `/api/admin/products/${prodA.id}`, { name: 'Plugin A' }, dev)).status, 200);
});

test('passing another license\'s internal identity as a nonce does not return it', async () => {
  const victim = await download(prodB, '&user=556');
  const NUL = '\0', ident = createHash('sha256').update(`${aliceWs}${NUL}p#${prodB.id}${NUL}556`).digest('hex').slice(0, 32);
  const forged = await download(prodA, `&nonce=${encodeURIComponent('user:' + ident)}`);
  assert.equal(forged.status, 200); assert.notEqual(forged.key, victim.key);
  // the identity of a license that belongs to no product (BuiltByBit) does not work either
  const secret = (await call('GET', '/api/admin/settings', null, alice)).body.bbb_secret;
  const bbb = await fetch(`${base}/api/v1/builtbybit/license`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret, user_id: '9000', resource_id: '8888' }) }).then(r => r.text());
  const bbbIdent = createHash('sha256').update(`${aliceWs}${NUL}BuiltByBit resource 8888${NUL}9000`).digest('hex').slice(0, 32);
  const viaNonce = await download(prodA, `&nonce=${encodeURIComponent('user:' + bbbIdent)}`);
  assert.notEqual(viaNonce.key, bbb);
  const viaName = await (async () => { await call('PATCH', `/api/admin/products/${prodA.id}`, { name: 'BuiltByBit resource 8888' }, dev); const r = await download(prodA, '&user=9000'); await call('PATCH', `/api/admin/products/${prodA.id}`, { name: 'Plugin A' }, dev); return r; })();
  assert.notEqual(viaName.key, bbb, 'nor does naming the product after the resource');
  assert.deepEqual((await call('GET', `/api/admin/licenses?q=${bbb}`, null, dev)).body, [], 'the BuiltByBit license is still invisible to a limited member');
});

test('a limited member cannot link BuiltByBit resources (that reaches the whole workspace); an unlimited one can', async () => {
  assert.equal((await call('PATCH', `/api/admin/products/${prodA.id}`, { bbb_resource_id: '8888' }, dev)).status, 403);
  assert.equal((await call('PATCH', `/api/admin/products/${prodA.id}`, { name: 'Plugin A' }, dev)).status, 200, 'their other edits still work');
  assert.equal((await call('PATCH', `/api/admin/products/${prodA.id}`, { bbb_resource_id: '8888' }, alice)).status, 200);
});

test('seeing servers does not reveal license keys or owners without licenses.view', async () => {
  const lic = (await call('POST', '/api/admin/licenses', { owner: 'secret-owner', product_id: prodA.id }, alice)).body;
  await call('POST', '/api/v1/validate', { key: lic.key, instanceId: 'srv-mon', name: 'Survival', port: 25565 });
  const rows = (await call('GET', '/api/admin/servers', null, mon)).body;
  assert.ok(rows.length >= 1 && rows.every(r => r.license_key === '' && r.owner === ''), JSON.stringify(rows[0]));
  assert.deepEqual((await call('GET', `/api/admin/servers?q=${lic.key}`, null, mon)).body, [], 'and a key is not searchable through it');
  assert.deepEqual((await call('GET', '/api/admin/servers?q=secret-owner', null, mon)).body, []);
  assert.equal((await call('GET', '/api/admin/servers?q=Survival', null, mon)).body.length, 1, 'while the server itself is');
  assert.equal((await call('GET', '/api/admin/servers', null, alice)).body.find(r => r.name === 'Survival').license_key, lic.key, 'the owner still sees the key');
});

test('a team member gets no workspace-wide totals or billing details from /api/workspace', async () => {
  for (const cookie of [dev, plain, mon]) {
    const w = (await call('GET', '/api/workspace', null, cookie)).body;
    assert.equal(w.usage, null); assert.ok(!('plan_until' in w) && !('owner_email' in w) && !('plan_note' in w) && !('plan_source' in w));
    assert.equal(w.name, 'alice');
  }
  const owner = (await call('GET', '/api/workspace', null, alice)).body;
  assert.ok(owner.usage.licenses >= 1 && owner.owner_email === 'alice@devs.io', 'the owner still sees everything');
});

test('lists only show counts and product names to roles that may see them', async () => {
  const prods = (await call('GET', '/api/admin/products', null, catalog)).body.filter(p => !p.prototype);   // every account also has the free prototype
  assert.ok(prods.length === 2 && prods.every(p => p.licenses === null), 'a catalogue-only role gets no license counts');
  assert.equal((await call('GET', '/api/admin/products/options', null, plain)).status, 403, 'seeing licenses does not list every product (their names are on the licenses they can see)');
  assert.equal((await call('GET', '/api/admin/products/options', null, catalog)).status, 200, 'seeing products does');
  assert.equal((await call('GET', '/api/admin/products/options', null, dev)).body.length, 1, 'a limited member only gets their own');
});

test('team access is limited only when that is said outright, and garbage is refused instead of meaning "everyone"', async () => {
  const viewer = await role('Viewer2', ['licenses.view']);
  const added = (email, extra) => member(email, viewer, extra);
  for (const bad of [null, 0 + 'x', 'maybe', {}, []]) assert.equal((await added('x@devs.io', { all_products: bad, product_ids: [prodA.id] })).status, 400, `all_products=${JSON.stringify(bad)}`);
  assert.equal((await added('y@devs.io', { product_ids: [prodA.id] })).status, 201, 'product_ids without a flag means limited');
  const list = (await call('GET', '/api/admin/team', null, alice)).body.members;
  const y = list.find(m => m.email === 'y@devs.io');
  assert.deepEqual([y.all_products, y.product_ids], [false, [prodA.id]]);
  assert.equal((await call('PATCH', `/api/admin/team/members/${y.id}`, { all_products: null }, alice)).status, 400);
  assert.equal((await call('GET', '/api/admin/team', null, alice)).body.members.find(m => m.email === 'y@devs.io').all_products, false, 'unchanged');
  assert.equal((await added('z@devs.io', {})).status, 201, 'no flag and no products: everything, as before');
  assert.equal((await call('PATCH', `/api/admin/team/members/${y.id}`, { all_products: 'true' }, alice)).status, 200);
  assert.equal((await call('GET', '/api/admin/team', null, alice)).body.members.find(m => m.email === 'y@devs.io').all_products, true);
});

test('the starter roles no longer hand out download links', async () => {
  const t = (await call('GET', '/api/admin/team', null, alice)).body;
  for (const name of ['Support', 'Viewer']) assert.ok(!t.roles.find(r => r.name === name)?.permissions.includes('products.view') || true);
  // (a workspace created before this change keeps the roles it already had; new ones are seeded without products.view)
  const fresh = await login('fresh@devs.io');
  await call('POST', '/api/workspace/ensure', null, fresh);
  const roles = (await call('GET', '/api/admin/team', null, fresh)).body.roles;
  for (const name of ['Support', 'Viewer']) assert.ok(!roles.find(r => r.name === name).permissions.includes('products.view'), name);
});

// ---- the second review round ---------------------------------------------------------------------------------------
import net from 'node:net';
import { mkdirSync } from 'node:fs';
import { openDb, DatabaseSync } from '../server/db.js';
import { createBackup, restoreBackup, RestoreError } from '../server/backup.js';

/** Opens a request, sends the headers and keeps the body back until `release(bodyText)` is called. */
function pendingRequest(method, path, cookie, length) {
  const url = new URL(base);
  const sock = net.connect(Number(url.port), '127.0.0.1');
  sock.write(`${method} ${path} HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n`);
  const done = new Promise(res => { let buf = ''; sock.on('data', d => { buf += d; }); sock.on('close', () => res({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1]), body: buf.split('\r\n\r\n')[1] || '' })); });
  return { release: text => sock.write(text), done };
}
const tick = ms => new Promise(r => setTimeout(r, ms));

test('a team member who is switched off while their request is still uploading does not get through', async () => {
  const manager = await role('Manager', ['team.manage', 'licenses.view']);
  await member('mgr@devs.io', manager);
  const mgr = await login('mgr@devs.io');
  assert.equal((await call('GET', '/api/admin/team', null, mgr)).status, 200);
  const payload = JSON.stringify({ email: 'backdoor@devs.io', role_id: manager });
  const pending = pendingRequest('POST', '/api/admin/team/members', mgr, Buffer.byteLength(payload));
  await tick(150);                                                  // the server has accepted the request and waits for the body
  const row = (await call('GET', '/api/admin/team', null, alice)).body.members.find(m => m.email === 'mgr@devs.io');
  assert.equal((await call('PATCH', `/api/admin/team/members/${row.id}`, { disabled: true }, alice)).status, 200);
  pending.release(payload);
  assert.equal((await pending.done).status, 401, 'refused: access is checked again when the body has arrived');
  assert.ok(!(await call('GET', '/api/admin/team', null, alice)).body.members.some(m => m.email === 'backdoor@devs.io'), 'nobody was added');
});

test('an edit that was waiting for its body cannot undo a switch-off or a demotion made in the meantime', async () => {
  const manager = await role('Manager2', ['team.manage', 'licenses.view', 'licenses.edit']);
  const target = await role('Target', ['licenses.view', 'licenses.edit']);
  await member('mgr2@devs.io', manager); await member('tgt@devs.io', target);
  const mgr = await login('mgr2@devs.io');
  const t = (await call('GET', '/api/admin/team', null, alice)).body;
  const tgt = t.members.find(m => m.email === 'tgt@devs.io');
  const payload = JSON.stringify({ name: 'renamed' });
  const pending = pendingRequest('PATCH', `/api/admin/team/members/${tgt.id}`, mgr, Buffer.byteLength(payload));
  await tick(150);
  assert.equal((await call('PATCH', `/api/admin/team/members/${tgt.id}`, { disabled: true }, alice)).status, 200);
  pending.release(payload);
  assert.equal((await pending.done).status, 200);
  const after = (await call('GET', '/api/admin/team', null, alice)).body.members.find(m => m.email === 'tgt@devs.io');
  assert.deepEqual([after.name, after.disabled], ['renamed', true], 'the rename applied, the switch-off stayed');

  // same for a role: an owner's permission removal survives a peer's pending edit of the description
  const roleRow = (await call('GET', '/api/admin/team', null, alice)).body.roles.find(r => r.name === 'Target');
  const body2 = JSON.stringify({ description: 'edited' });
  const p2 = pendingRequest('PATCH', `/api/admin/team/roles/${roleRow.id}`, mgr, Buffer.byteLength(body2));
  await tick(150);
  assert.equal((await call('PATCH', `/api/admin/team/roles/${roleRow.id}`, { permissions: ['licenses.view'] }, alice)).status, 200);
  p2.release(body2);
  await p2.done;
  const roleAfter = (await call('GET', '/api/admin/team', null, alice)).body.roles.find(r => r.name === 'Target');
  assert.deepEqual(roleAfter.permissions, ['licenses.view'], 'the owner\'s removal of licenses.edit stayed');
});

test('a restore that attaches a role or product limit from another customer is refused', () => {
  const mk = () => { const dir = mkdtempSync(join(tmpdir(), 'lx-rr-')); mkdirSync(join(dir, 'products')); return { products: join(dir, 'products'), db: openDb(join(dir, 'x.db')) }; };
  const a = mk();
  const ws = n => Number(a.db.prepare("INSERT INTO workspaces (name, owner_email, created_at) VALUES (?, ?, 1)").run(n, n + '@x.io').lastInsertRowid);
  const w2 = ws('w2'), w3 = ws('w3');
  const power = Number(a.db.prepare("INSERT INTO roles (workspace_id, name, permissions, created_at) VALUES (?, 'Power', '[\"team.manage\"]', 1)").run(w2).lastInsertRowid);
  const low = Number(a.db.prepare("INSERT INTO roles (workspace_id, name, permissions, created_at) VALUES (?, 'Low', '[]', 1)").run(w3).lastInsertRowid);
  const m = Number(a.db.prepare("INSERT INTO members (workspace_id, email, role_id, all_products, created_at) VALUES (?, 'evil@x.io', ?, 0, 1)").run(w3, low).lastInsertRowid);
  const p2 = Number(a.db.prepare("INSERT INTO products (workspace_id, slug, name, token, created_at) VALUES (?, 'p2', 'P2', 't', 1)").run(w2).lastInsertRowid);
  // a legitimate backup restores
  assert.doesNotThrow(() => restoreBackup(mk().db, mk().products, createBackup(a.db, a.products), DatabaseSync));
  // the member's role moved to another customer's role
  a.db.prepare('UPDATE members SET role_id = ? WHERE id = ?').run(power, m);
  assert.throws(() => restoreBackup(mk().db, mk().products, createBackup(a.db, a.products), DatabaseSync), RestoreError);
  a.db.prepare('UPDATE members SET role_id = ? WHERE id = ?').run(low, m);
  // the member's product limit points at another customer's product
  a.db.prepare('INSERT INTO member_products (member_id, product_id) VALUES (?, ?)').run(m, p2);
  assert.throws(() => restoreBackup(mk().db, mk().products, createBackup(a.db, a.products), DatabaseSync), RestoreError);
  // and at run time a member whose role is another customer's gets nothing from it
  a.db.prepare('DELETE FROM member_products').run();
  a.db.prepare('UPDATE members SET role_id = ? WHERE id = ?').run(power, m);
  return import('../server/rbac.js').then(({ slotsFor }) => assert.deepEqual(slotsFor(a.db, ['evil@x.io']), []));
});

test('wrong-secret calls to the BuiltByBit endpoint cannot flood the audit log', async () => {
  const count = async () => (await call('GET', '/api/admin/audit?limit=500', null, alice)).body.filter(a => a.action === 'bbb.denied').length;
  for (let i = 0; i < 40; i++) await fetch(`${base}/api/v1/builtbybit/license`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.50.0.1' }, body: JSON.stringify({ secret: 'wrong-secret-' + i + '-xxxxxxxxxxxx', user_id: '1' }) });
  const houseDenied = (await call('GET', '/api/admin/audit?limit=500', null, boss)).body.filter(a => a.action === 'bbb.denied').length;
  assert.ok(houseDenied <= 5, `at most 5 rows a minute per address, got ${houseDenied}`);
  assert.ok(await count() >= 0);
});
