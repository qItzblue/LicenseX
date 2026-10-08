import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startMock, oauthEnv, googleUser, signIn } from './helpers/oauth-mock.mjs';
import { openDb, DatabaseSync } from '../server/db.js';
import { createCore, hash } from '../server/core.js';
import { createBackup, restoreBackup, RestoreError } from '../server/backup.js';

// ---- backup / restore with customers (workspaces) --------------------------------------------------------------
const scratch = () => mkdtempSync(join(tmpdir(), 'lx-fix-'));
function makeServer() {
  const dir = scratch(), products = join(dir, 'products'); mkdirSync(products);
  const db = openDb(join(dir, 'lx.db'));
  return { dir, products, db, core: createCore(db) };
}
function addCustomer(db, email, plan = 'lifetime') {
  const id = db.prepare("INSERT INTO workspaces (name, owner_email, plan_key, plan_source, bbb_secret, created_at) VALUES (?, ?, ?, 'manual', ?, 1)").run(email, email, plan, 'secret-' + email).lastInsertRowid;
  db.prepare("INSERT INTO ws_settings (workspace_id, key, value) VALUES (?, 'default_limit', '7')").run(id);
  return Number(id);
}

test('restoring a backup on a fresh host brings back every customer, plan and setting, and nobody can adopt their data', () => {
  const a = makeServer(), ws = addCustomer(a.db, 'alice@devs.io');
  a.core.createLicense({ workspace_id: ws, owner: 'ALICE-SECRET-BUYER' });
  a.db.prepare("INSERT INTO products (workspace_id, slug, name, token, has_file, created_at) VALUES (?, 'alice-premium', 'Alice Premium', 'tok', 1, 1)").run(ws);
  const big = randomBytes(12 * 1024 * 1024); // a plugin jar well over 8 MB
  writeFileSync(join(a.products, 'alice-premium.bin'), big);
  const zip = createBackup(a.db, a.products);

  const b = makeServer(); // a brand-new, empty installation
  const r = restoreBackup(b.db, b.products, zip, DatabaseSync);
  assert.equal(r.products, 1);
  assert.deepEqual(b.db.prepare('SELECT id, owner_email, plan_key, plan_source, bbb_secret FROM workspaces ORDER BY id').all().map(w => [w.id, w.owner_email, w.plan_key, w.plan_source, w.bbb_secret]),
    a.db.prepare('SELECT id, owner_email, plan_key, plan_source, bbb_secret FROM workspaces ORDER BY id').all().map(w => [w.id, w.owner_email, w.plan_key, w.plan_source, w.bbb_secret]));
  assert.equal(b.db.prepare("SELECT value FROM ws_settings WHERE workspace_id = ? AND key = 'default_limit'").get(ws).value, '7');
  assert.equal(b.db.prepare('SELECT owner FROM licenses WHERE workspace_id = ?').get(ws).owner, 'ALICE-SECRET-BUYER');
  assert.ok(readFileSync(join(b.products, 'alice-premium.bin')).equals(big), 'the big plugin file came back intact');
  assert.equal(b.db.prepare("SELECT has_file FROM products WHERE slug = 'alice-premium'").get().has_file, 1);
  // the next signup gets a fresh id, never one that existing data points at
  const next = Number(b.db.prepare("INSERT INTO workspaces (name, owner_email, created_at) VALUES ('m', 'mallory@evil.io', 1)").run().lastInsertRowid);
  assert.ok(next > ws);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM licenses WHERE workspace_id = ?').get(next).n, 0);
});

test('a backup that references customers it does not contain is refused and changes nothing', () => {
  const a = makeServer();
  a.core.createLicense({ workspace_id: 1, owner: 'mine' });
  a.db.exec("PRAGMA foreign_keys = OFF");
  a.db.prepare("INSERT INTO licenses (workspace_id, key, owner, created_at) VALUES (99, 'LX-AAAA-BBBB-CCCC-DDDD', 'orphan', 1)").run();
  const zip = createBackup(a.db, a.products);
  const b = makeServer(); b.core.createLicense({ workspace_id: 1, owner: 'keep-me' });
  assert.throws(() => restoreBackup(b.db, b.products, zip, DatabaseSync), RestoreError);
  assert.deepEqual(b.db.prepare('SELECT owner FROM licenses').all().map(x => x.owner), ['keep-me'], 'the failed restore rolled back');
});

test('an old backup without customers leaves the current customers alone', () => {
  const old = makeServer();
  old.core.createLicense({ workspace_id: 1, owner: 'from-old-backup' });
  for (const t of ['stripe_events', 'ws_settings', 'plans', 'workspaces']) old.db.exec(`DROP TABLE ${t}`);
  const zip = createBackup(old.db, old.products);
  const cur = makeServer(), ws = addCustomer(cur.db, 'bob@devs.io');
  restoreBackup(cur.db, cur.products, zip, DatabaseSync);
  assert.equal(cur.db.prepare('SELECT COUNT(*) n FROM workspaces WHERE id = ?').get(ws).n, 1, 'bob still has his workspace');
  assert.ok(cur.db.prepare('SELECT 1 FROM plans').get(), 'plans are still there');
  assert.deepEqual(cur.db.prepare('SELECT owner FROM licenses').all().map(x => x.owner), ['from-old-backup']);
});

test('data pointing at an unowned workspace id is never adopted by a new customer', () => {
  const dir = scratch(), file = join(dir, 'x.db');
  const db = openDb(file);
  db.prepare("INSERT INTO licenses (workspace_id, key, owner, created_at) VALUES (7, 'LX-AAAA-BBBB-CCCC-DDDD', 'orphan', 1)").run();
  db.close();
  const again = openDb(file); // what a restart does
  const id = Number(again.prepare("INSERT INTO workspaces (name, owner_email, created_at) VALUES ('n', 'n@x.io', 1)").run().lastInsertRowid);
  assert.ok(id > 7, `new workspace id ${id} must be above 7`);
});

// ---- buyer identities are namespaced per workspace -------------------------------------------------------------
test('one developer cannot craft a nonce that blocks another developer\'s buyer', () => {
  const { db, core } = makeServer();
  const w2 = addCustomer(db, 'two@devs.io', 'free'), w3 = addCustomer(db, 'three@devs.io', 'free');
  const NUL = '\0', forged = 'user:' + hash(w2 + NUL + 'Plugin' + NUL + '777');
  assert.equal(core.claim({ ws: w3, nonce: forged, product: 'Plugin', ip: '1.1.1.1', device: 'd' }).ok, true);
  const victim = core.claim({ ws: w2, user: '777', product: 'Plugin', ip: '2.2.2.2', device: 'd' });
  assert.equal(victim.ok, true, 'the real buyer still gets a license');
  assert.equal(core.claim({ ws: w2, user: '777', product: 'Plugin', ip: '2.2.2.2', device: 'd' }).key, victim.key, 'and keeps it');
});

test('licenses issued before nonces were namespaced keep working for their own workspace only', () => {
  const { db, core } = makeServer();
  const w2 = addCustomer(db, 'two@devs.io', 'free'), w3 = addCustomer(db, 'three@devs.io', 'free');
  const legacy = core.createLicense({ workspace_id: w2, source: 'claim', nonce: 'old-nonce-1' });
  const again = core.claim({ ws: w2, nonce: 'old-nonce-1', ip: 'i', device: 'd' });
  assert.equal(again.key, legacy.key); assert.equal(again.created, false);
  const other = core.claim({ ws: w3, nonce: 'old-nonce-1', ip: 'i', device: 'd' });
  assert.equal(other.ok, true); assert.notEqual(other.key, legacy.key, 'another workspace gets its own, not an error');
});

// ---- the HTTP side: public downloads, quota, purge, slugs ------------------------------------------------------
const mock = await startMock();
process.env.LICENSEX_DATA = scratch();
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_ADMIN_EMAILS = 'boss@example.com';
process.env.LICENSEX_SIGNUPS_PER_IP_HOUR = '1000';
process.env.LICENSEX_MINT_PER_HOUR = '5';
process.env.TRUST_PROXY = '1'; // so each test can come from its own address
Object.assign(process.env, oauthEnv(mock.base));
const { server } = await import('../server/index.js');
let base, boss, alice;
after(() => { server.close(); mock.close(); });
const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
const call = (method, path, body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
async function product(cookie, name) {
  const p = (await call('POST', '/api/admin/products', { name }, cookie)).body;
  const up = await fetch(`${base}/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'p.jar' }, body: plugin });
  assert.equal(up.status, 200);
  return p;
}
const dl = (p, q = '', ip = '10.0.0.1') => fetch(`${base}/download/${p.slug}?token=${p.token}${q}`, { headers: { 'X-Forwarded-For': ip } }).then(async r => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }));
before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  boss = await signIn(base, mock, googleUser('boss@example.com'));
  alice = await signIn(base, mock, googleUser('alice@devs.io'));
  await call('POST', '/api/workspace/ensure', null, alice);
  await call('POST', '/api/admin/customers/2/plan', { plan_key: 'pro' }, boss);
});

test('long product names get unique slugs that still fit the 48-character limit', async () => {
  const name = 'A very long plugin name that goes on and on and on forever and ever';
  const one = (await call('POST', '/api/admin/products', { name }, alice)).body, two = (await call('POST', '/api/admin/products', { name }, alice)).body;
  assert.ok(one.slug.length <= 48 && two.slug.length <= 48, `${one.slug} / ${two.slug}`);
  assert.notEqual(one.slug, two.slug);
  assert.match(two.slug, /-2$/);
});

test('a public download link can only mint a limited number of new licenses per hour', async () => {
  const a = await product(alice, 'Cap Plugin A'), b = await product(alice, 'Cap Plugin B'), c = await product(alice, 'Cap Plugin C');
  assert.equal((await dl(a, '&user=1234')).status, 200, 'a known buyer');
  for (let i = 0; i < 4; i++) assert.equal((await dl(a)).status, 200, `anonymous download ${i + 1}`);
  const over = await dl(a);
  assert.equal(over.status, 429, 'the per-product cap (5 new licenses an hour) is reached');
  assert.equal((await dl(a, '&user=1234')).status, 200, 'but a buyer who already has a license can always download again');
  const audit = (await call('GET', '/api/admin/audit?limit=50', null, alice)).body;
  assert.ok(audit.some(x => x.action === 'download.throttled'), 'the developer can see it happened');
  // the per-address cap spans products: 5 more on B reach 10 for this address, so C is refused although it has none yet
  for (let i = 0; i < 5; i++) assert.equal((await dl(b)).status, 200);
  assert.equal((await dl(c)).status, 429, 'ten new licenses an hour is the limit per address');
});

test('a developer at the plan limit shows buyers a neutral message, not their plan', async () => {
  const bob = await signIn(base, mock, googleUser('bob@devs.io'));
  await call('POST', '/api/workspace/ensure', null, bob);
  await call('POST', '/api/admin/plans', { key: 'tiny', name: 'Tiny', max_products: 2, max_licenses: 1, price_cents: 100, interval: 'once' }, boss);
  const bobId = (await call('GET', '/api/admin/customers', null, boss)).body.find(c => c.owner_email === 'bob@devs.io').id;
  await call('POST', `/api/admin/customers/${bobId}/plan`, { plan_key: 'tiny' }, boss);
  const p = await product(bob, 'Bob Plugin');
  assert.equal((await dl(p, '&user=1', '10.0.0.2')).status, 200);
  const refused = await dl(p, '&user=2', '10.0.0.2');
  assert.equal(refused.status, 503);
  assert.doesNotMatch(refused.body.message, /plan|Tiny|upgrade/i);
  assert.ok((await call('GET', '/api/admin/audit?limit=20', null, bob)).body.some(x => x.action === 'download.refused' && /Tiny/.test(x.detail)), 'the real reason is in the developer\'s audit log');
});

test('the developer can delete downloaded-but-never-used licenses in one go', async () => {
  const eve = await signIn(base, mock, googleUser('eve@devs.io'));
  await call('POST', '/api/workspace/ensure', null, eve);
  await call('POST', '/api/admin/customers/' + (await call('GET', '/api/admin/customers', null, boss)).body.find(c => c.owner_email === 'eve@devs.io').id + '/plan', { plan_key: 'pro' }, boss);
  const p = await product(eve, 'Eve Plugin');
  const manual = (await call('POST', '/api/admin/licenses', { owner: 'friend' }, eve)).body;
  for (const u of ['a', 'b', 'c']) await dl(p, '&user=' + u, '10.0.0.3');
  const licenses = (await call('GET', '/api/admin/licenses', null, eve)).body;
  const used = licenses.find(l => l.owner === 'b');
  await call('POST', '/api/v1/validate', { key: used.key, instanceId: 'srv-1', name: 's', port: 25565 });
  const dry = await call('POST', '/api/admin/licenses/purge-unused', { older_than_days: 0, dry_run: true }, eve);
  assert.deepEqual([dry.body.count, dry.body.deleted], [2, false]);
  assert.equal((await call('GET', '/api/admin/licenses', null, eve)).body.length, 4, 'a dry run deletes nothing');
  const done = await call('POST', '/api/admin/licenses/purge-unused', { older_than_days: 0 }, eve);
  assert.deepEqual([done.body.count, done.body.deleted], [2, true]);
  const left = (await call('GET', '/api/admin/licenses', null, eve)).body.map(l => l.owner).sort();
  assert.deepEqual(left, ['b', 'friend'], 'the hand-made license and the one that is in use stay');
  const junk = await call('POST', '/api/admin/licenses/purge-unused', { older_than_days: 0 }, alice); // alice has the unused downloads from the cap test
  assert.equal(junk.body.count, 10);
  assert.deepEqual((await call('GET', '/api/admin/licenses', null, eve)).body.map(l => l.owner).sort(), ['b', 'friend'], 'and it only ever touches your own workspace');
  assert.ok(manual.id);
});
