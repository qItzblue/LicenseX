import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, oauthEnv, googleUser, signIn } from './helpers/oauth-mock.mjs';

const mock = await startMock();
const DATA = mkdtempSync(join(tmpdir(), 'lx-buyers-'));
process.env.LICENSEX_DATA = DATA;
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_ADMIN_EMAILS = 'boss@example.com';
process.env.LICENSEX_SIGNUPS_PER_IP_HOUR = '1000';
// Every test pretends to come from its own address (X-Forwarded-For), so the per-address rate limits cannot leak from one test into the next.
process.env.TRUST_PROXY = '1';
Object.assign(process.env, oauthEnv(mock.base));
const { server } = await import('../server/index.js');
const { DatabaseSync } = await import('../server/db.js');
let base, side;
after(() => { server.close(); mock.close(); side?.close(); });

let ip = '10.7.0.1';
const at = n => { ip = `10.7.0.${n}`; };
const call = (method, path, body, cookie, headers = {}) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// The admin API has no way to say "sold to this email" or "belongs to this product" yet, so the tests write those columns directly.
const sql = (q, ...args) => side.prepare(q).run(...args);
const rows = (q, ...args) => side.prepare(q).all(...args);
const mint = async (cookie, fields = {}) => (await call('POST', '/api/admin/licenses', { owner: 'steve', max_servers: 5, ...fields }, cookie)).body;
const register = (key, instanceId, name = 'Lobby') => call('POST', '/api/v1/validate', { key, instanceId, name, port: 25565 });
// A signed session for any kind of visitor (a GitHub account with two emails, a Discord account with none ...): same signing as the server.
const forge = (user, { exp = Date.now() + 36e5, secret = readFileSync(join(DATA, 'session.secret'), 'utf8').trim() } = {}) => {
  const p = Buffer.from(JSON.stringify({ ...user, exp })).toString('base64url');
  return `lx_user=${p}.${createHmac('sha256', secret).update(p).digest('base64url')}`;
};
const profile = (sub, email, { verified = true } = {}) => ({ user: { sub, email, email_verified: verified, name: email.split('@')[0], picture: '' } });
/** Signs `profile` in through the real redirect flow, from the current test address. Returns the session cookie and where sign-in ended up. */
async function login(profile, next) {
  mock.as(profile);
  const from = { 'X-Forwarded-For': ip };
  const start = await fetch(`${base}/auth/google${next === undefined ? '' : '?next=' + encodeURIComponent(next)}`, { redirect: 'manual', headers: from });
  assert.equal(start.status, 302);
  const named = (res, name) => res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith(name + '='));
  const atProvider = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(atProvider.headers.get('location'));
  const done = await fetch(base + cb.pathname + cb.search, { redirect: 'manual', headers: { ...from, Cookie: named(start, 'lx_oauth') } });
  assert.equal(done.status, 302);
  return { cookie: named(done, 'lx_user'), location: done.headers.get('location') };
}
const buyer = async name => (await login(googleUser(`${name}@buyers.io`))).cookie;
const ENTRY_KEYS = ['block_reason', 'created_at', 'developer', 'expires_at', 'group', 'id', 'key', 'limit', 'owner', 'product', 'public_removal', 'servers', 'state', 'used', 'via'];

let boss, alice, bob;
before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  side = new DatabaseSync(join(DATA, 'licensex.db'));
  side.exec('PRAGMA busy_timeout = 5000');
  boss = await signIn(base, mock, googleUser('boss@example.com'));
  alice = await signIn(base, mock, googleUser('alice@devs.io'));
  bob = await signIn(base, mock, googleUser('bob@devs.io'));
  await call('POST', '/api/workspace/ensure', null, alice);
  await call('POST', '/api/workspace/ensure', null, bob);
});

test('every account route needs a signed-in visitor; the admin password and bad cookies are not accounts', async () => {
  at(1);
  const lic = await mint(boss);
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  const adminPw = login.headers.get('set-cookie').split(';')[0];
  const user = { p: 'google', id: 'x1', name: 'x', emails: [] };
  const bad = [undefined, adminPw, 'lx_user=garbage', 'lx_user=%', forge(user, { exp: Date.now() - 1000 }), forge(user, { secret: 'not-the-server-secret' }), forge({ ...user, id: '' }), forge({ name: 'no provider' })];
  for (const cookie of bad) {
    for (const [m, p, b] of [['GET', '/api/account'], ['POST', '/api/account/licenses', { key: lic.key }], ['DELETE', `/api/account/licenses/${lic.id}`], ['POST', `/api/account/licenses/${lic.id}/remove-server`, { serverId: 1 }]]) {
      const r = await call(m, p, b, cookie);
      assert.equal(r.status, 401, `${m} ${p} with ${cookie}`);
      assert.equal(r.body.message, 'Sign in first.');
    }
  }
  assert.equal((await call('GET', '/api/account', undefined, forge(user))).status, 200, 'a correctly signed session works (the forge helper matches the server)');
  assert.equal(rows('SELECT * FROM buyer_links').length, 0, 'nothing was linked by the failed calls');
});

test('linking a license by key: lower case and spaces are fine, it is idempotent, and the response carries no internals', async () => {
  at(2);
  const ann = await buyer('ann');
  const lic = await mint(boss, { owner: 'Ann Smith', note: 'internal note', max_servers: 3 });
  sql("UPDATE licenses SET issued_ip='9.9.9.9', issued_device='dev-hash', product='Lobby Plugin' WHERE id=?", lic.id);
  await register(lic.key, 'srv-a', 'Lobby');

  assert.deepEqual((await call('GET', '/api/account', undefined, ann)).body.licenses, [], 'a new account starts empty');
  const first = await call('POST', '/api/account/licenses', { key: `  ${lic.key.toLowerCase()} ` }, ann);
  assert.equal(first.status, 201);
  assert.deepEqual(Object.keys(first.body).sort(), ENTRY_KEYS, 'only the buyer-facing fields');
  assert.equal(first.body.key, lic.key); assert.equal(first.body.id, lic.id);
  assert.equal(first.body.via, 'key'); assert.equal(first.body.state, 'active');
  assert.equal(first.body.owner, 'Ann Smith'); assert.equal(first.body.limit, 3); assert.equal(first.body.used, 1);
  assert.equal(first.body.product, 'Lobby Plugin', 'falls back to the product name the license was issued under');
  assert.equal(first.body.developer, 'LicenseX', 'the owner\'s own licenses show the site name');
  assert.equal(first.body.public_removal, true);
  assert.match(first.body.servers[0].ip, /\.x$/, 'server addresses are masked like on the public page');
  assert.ok(!JSON.stringify(first.body).match(/internal note|9\.9\.9\.9|dev-hash|workspace_id|buyer_email|nonce/), 'no notes, addresses or hashes');

  const again = await call('POST', '/api/account/licenses', { key: lic.key }, ann);
  assert.equal(again.status, 200, 'second time: already there');
  assert.deepEqual(again.body, first.body);
  assert.equal(rows('SELECT * FROM buyer_links WHERE license_id=?', lic.id).length, 1);

  const list = (await call('GET', '/api/account', undefined, ann)).body;
  assert.deepEqual(list.user, { name: 'ann', email: 'ann@buyers.io', avatar: '', provider: 'google' });
  assert.deepEqual(list.licenses.map(l => l.key), [lic.key]);

  // signing in again later (a new session) is the same account
  const ann2 = await buyer('ann');
  assert.notEqual(ann2, ann);
  assert.deepEqual((await call('GET', '/api/account', undefined, ann2)).body.licenses.map(l => l.key), [lic.key]);
  // and somebody else's account does not have it
  assert.deepEqual((await call('GET', '/api/account', undefined, await buyer('ben'))).body.licenses, []);
});

test('a wrong key answers like the public lookup, whatever is wrong with it; blocked licenses reveal no more than the public page', async () => {
  at(3);
  const gus = await buyer('gus');
  const publicMiss = await call('POST', '/api/public/lookup', { key: 'LX-AAAA-AAAA-AAAA-AAAA' });
  assert.equal(publicMiss.status, 404);
  for (const b of [{ key: 'LX-AAAA-AAAA-AAAA-AAAA' }, { key: 'nope' }, { key: '' }, {}, { key: 12345 }, { key: ['LX-AAAA-AAAA-AAAA-AAAA'] }, { key: { $ne: 1 } }, undefined, '5', '[1]', 'null']) {
    const r = await call('POST', '/api/account/licenses', b, gus);
    assert.equal(r.status, 404, JSON.stringify(b));
    assert.deepEqual(r.body, publicMiss.body, `same answer for ${JSON.stringify(b)}`);
  }
  assert.equal((await call('POST', '/api/account/licenses', 'not json', gus)).status, 400, 'broken JSON is a client error, not a crash');
  assert.deepEqual((await call('GET', '/api/account', undefined, gus)).body.licenses, [], 'nothing got linked');

  const blocked = await mint(boss);
  await call('PATCH', `/api/admin/licenses/${blocked.id}`, { status: 'blocked', block_reason: 'chargeback' }, boss);
  const pub = (await call('POST', '/api/public/lookup', { key: blocked.key })).body;
  const linked = await call('POST', '/api/account/licenses', { key: blocked.key }, gus);
  assert.equal(linked.status, 201, 'a blocked license is found, just like on the public page');
  assert.equal(linked.body.state, pub.state); assert.equal(linked.body.state, 'blocked');
  assert.equal(linked.body.block_reason, pub.block_reason);
  // the id in the URL is never enough: junk ids are plain "not found"
  for (const id of ['abc', '1e3', '-1', '0', '0x10', '99999999999999999999', '1%20OR%201=1', '%00']) {
    assert.equal((await call('DELETE', `/api/account/licenses/${id}`, undefined, gus)).status, 404, `DELETE ${id}`);
    assert.equal((await call('POST', `/api/account/licenses/${id}/remove-server`, { serverId: 1 }, gus)).status, 404, `remove ${id}`);
  }
});

test('product and developer names come from the license\'s own workspace, never another one\'s', async () => {
  at(4);
  const cy = await buyer('cy');
  const prodA = (await call('POST', '/api/admin/products', { name: 'Alice Plugin' }, alice)).body;
  const prodB = (await call('POST', '/api/admin/products', { name: 'Bob Secret Tool' }, bob)).body;
  const la = await mint(alice, { owner: 'cy' });
  sql('UPDATE licenses SET product_id=? WHERE id=?', prodA.id, la.id);
  const r = await call('POST', '/api/account/licenses', { key: la.key }, cy);
  assert.equal(r.status, 201);
  assert.equal(r.body.product, 'Alice Plugin');
  assert.equal(r.body.developer, 'alice', 'the creator\'s workspace name');

  // a (corrupt or hand-edited) product id from another workspace must not leak that workspace's product name
  const lb = await mint(alice, { owner: 'cy2' });
  sql("UPDATE licenses SET product_id=?, product='Fallback Name' WHERE id=?", prodB.id, lb.id);
  const r2 = await call('POST', '/api/account/licenses', { key: lb.key }, cy);
  assert.equal(r2.body.product, 'Fallback Name');
  assert.ok(!JSON.stringify(r2.body).includes('Bob Secret Tool'));
  // a license with neither shows an empty product, not "null"
  const lc = await mint(alice, { owner: 'cy3' });
  assert.equal((await call('POST', '/api/account/licenses', { key: lc.key }, cy)).body.product, '');
  // newest first
  const list = (await call('GET', '/api/account', undefined, cy)).body.licenses;
  assert.deepEqual(list.map(l => l.id), [lc.id, lb.id, la.id]);
});

test('licenses issued to an email appear on their own, but only for a PROVIDER-VERIFIED email (any case)', async () => {
  at(5);
  const carol = await buyer('carol');
  const l1 = await mint(alice, { owner: 'for carol' });
  const l2 = await mint(alice, { owner: 'for somebody else' });
  const l3 = await mint(alice, { owner: 'no email at all' });
  sql("UPDATE licenses SET buyer_email='Carol@Buyers.IO' WHERE id=?", l1.id);   // upper case on purpose: the match ignores case
  sql("UPDATE licenses SET buyer_email='someone-else@buyers.io' WHERE id=?", l2.id);

  const mine = (await call('GET', '/api/account', undefined, carol)).body.licenses;
  assert.deepEqual(mine.map(l => l.key), [l1.key], 'only the one issued to her email');
  assert.equal(mine[0].via, 'email');
  assert.ok(!JSON.stringify(mine).includes('buyers.io'), 'the stored email is not echoed back');

  // somebody who merely TYPED carol's address into their provider, unverified, gets nothing
  const mal = (await login(profile('g-mallory', 'carol@buyers.io', { verified: false }))).cookie;
  const m = (await call('GET', '/api/account', undefined, mal)).body;
  assert.equal(m.user.email, '', 'unverified email is not even shown');
  assert.deepEqual(m.licenses, []);
  assert.equal((await call('DELETE', `/api/account/licenses/${l1.id}`, undefined, mal)).status, 404);
  assert.equal((await call('POST', `/api/account/licenses/${l1.id}/remove-server`, { serverId: 1 }, mal)).status, 404);

  // a verified address that is merely similar does not match
  const other = await buyer('carol2');
  assert.deepEqual((await call('GET', '/api/account', undefined, other)).body.licenses, []);
  const near = forge({ p: 'google', id: 'near', name: 'n', emails: ['carol@buyers.io.evil.com', 'xcarol@buyers.io', 'carol@buyers.i', '%', '_arol@buyers.io', ''] });
  assert.deepEqual((await call('GET', '/api/account', undefined, near)).body.licenses, [], 'no LIKE-style or prefix matching');

  // GitHub people can have several verified emails: any one of them is enough
  const multi = forge({ p: 'github', id: '42', name: 'gh', emails: ['first@else.io', 'CAROL@buyers.io'] });
  assert.deepEqual((await call('GET', '/api/account', undefined, multi)).body.licenses.map(l => l.key), [l1.key]);

  // typing the key of an email-issued license is not needed, and does not create a second way in
  const again = await call('POST', '/api/account/licenses', { key: l1.key }, carol);
  assert.equal(again.status, 200); assert.equal(again.body.via, 'email');
  assert.equal(rows('SELECT * FROM buyer_links WHERE license_id=?', l1.id).length, 0);
  // a license that is neither emailed to her nor linked stays out
  assert.ok(!(await call('GET', '/api/account', undefined, carol)).body.licenses.some(l => l.key === l3.key));
});

test('unlinking removes the link only; email-issued licenses cannot be unlinked', async () => {
  at(6);
  const dee = await buyer('dee');
  const lic = await mint(boss, { owner: 'dee' });
  await register(lic.key, 'dee-1');
  await call('POST', '/api/account/licenses', { key: lic.key }, dee);

  const del = await call('DELETE', `/api/account/licenses/${lic.id}`, undefined, dee);
  assert.equal(del.status, 200);
  assert.deepEqual((await call('GET', '/api/account', undefined, dee)).body.licenses, []);
  const still = (await call('GET', `/api/admin/licenses/${lic.id}`, undefined, boss)).body;
  assert.equal(still.key, lic.key, 'the license itself still exists');
  assert.equal(still.servers.length, 1, 'and so does its server');
  assert.equal((await register(lic.key, 'dee-1')).status, 200, 'the plugin keeps working');
  assert.equal((await call('DELETE', `/api/account/licenses/${lic.id}`, undefined, dee)).status, 404, 'second unlink: nothing to unlink');
  assert.equal((await call('POST', `/api/account/licenses/${lic.id}/remove-server`, { serverId: still.servers[0].id }, dee)).status, 404, 'no access any more');
  assert.equal((await call('POST', '/api/account/licenses', { key: lic.key }, dee)).status, 201, 'it can be added again');

  // only because of the email: 409, and the license stays
  const mailed = await mint(boss, { owner: 'mailed' });
  sql("UPDATE licenses SET buyer_email='dee@buyers.io' WHERE id=?", mailed.id);
  const r = await call('DELETE', `/api/account/licenses/${mailed.id}`, undefined, dee);
  assert.equal(r.status, 409); assert.match(r.body.message, /email address/);
  assert.ok((await call('GET', '/api/account', undefined, dee)).body.licenses.some(l => l.id === mailed.id));

  // linked first, issued to the email later: the link can go, the license stays (because of the email), and then it is "only email"
  assert.equal((await call('POST', '/api/account/licenses', { key: mailed.key }, dee)).status, 200);
  sql("UPDATE licenses SET buyer_email='' WHERE id=?", mailed.id);
  assert.equal((await call('POST', '/api/account/licenses', { key: mailed.key }, dee)).status, 201, 'no longer emailed to her: linking works again');
  sql("UPDATE licenses SET buyer_email='dee@buyers.io' WHERE id=?", mailed.id);
  assert.equal((await call('GET', '/api/account', undefined, dee)).body.licenses.find(l => l.id === mailed.id).via, 'email');
  assert.equal((await call('DELETE', `/api/account/licenses/${mailed.id}`, undefined, dee)).status, 200, 'the stale link can be dropped');
  assert.ok((await call('GET', '/api/account', undefined, dee)).body.licenses.some(l => l.id === mailed.id), 'still listed because of the email');
  assert.equal((await call('DELETE', `/api/account/licenses/${mailed.id}`, undefined, dee)).status, 409);
});

test('removing a server follows the public page\'s rules exactly', async () => {
  at(7);
  const eve = await buyer('eve');
  const lic = await mint(boss, { owner: 'eve', max_servers: 3 });
  for (const id of ['s1', 's2', 's3']) assert.equal((await register(lic.key, id, 'Server ' + id)).status, 200);
  const { servers } = (await call('POST', '/api/account/licenses', { key: lic.key }, eve)).body;
  assert.equal(servers.length, 3);
  const srv = n => servers.find(s => s.name === 'Server ' + n);
  const remove = (license, serverId, cookie = eve) => call('POST', `/api/account/licenses/${license.id}/remove-server`, { serverId }, cookie);

  const r = await remove(lic, srv('s1').id);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ENTRY_KEYS);
  assert.equal(r.body.used, 2); assert.deepEqual(r.body.servers.map(s => s.name).sort(), ['Server s2', 'Server s3']);
  assert.equal((await register(lic.key, 's1')).body.code, 'SERVER_REMOVED', 'the running plugin learns about it at its next check-in');
  assert.equal((await register(lic.key, 's2')).status, 200, 'the others are untouched');

  const dup = await remove(lic, srv('s1').id);
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'NOT_FOUND');
  // same answer as the public endpoint
  const pub = await call('POST', '/api/public/remove', { key: lic.key, serverId: srv('s1').id });
  assert.equal(pub.status, 409); assert.equal(pub.body.code, 'NOT_FOUND');

  // an admin-disabled server keeps its slot and cannot be removed
  await call('PATCH', `/api/admin/servers/${srv('s2').id}`, { status: 'disabled' }, boss);
  const dis = await remove(lic, srv('s2').id);
  assert.equal(dis.status, 409); assert.equal(dis.body.code, 'SERVER_DISABLED');
  assert.equal((await call('POST', '/api/public/remove', { key: lic.key, serverId: srv('s2').id })).body.code, 'SERVER_DISABLED');
  assert.equal((await register(lic.key, 's2')).body.code, 'SERVER_DISABLED', 'still disabled, not removed');

  // bad server ids
  for (const bad of [0, -1, 'x', null, undefined, 1.5, {}]) assert.equal((await remove(lic, bad)).status, 400, JSON.stringify(bad));

  // a server of ANOTHER license cannot be removed through this one, even if the buyer has access to both
  const other = await mint(boss, { owner: 'eve-2' });
  await register(other.key, 'o1');
  const otherServer = (await call('POST', '/api/account/licenses', { key: other.key }, eve)).body.servers[0];
  const cross = await remove(lic, otherServer.id);
  assert.equal(cross.status, 409); assert.equal(cross.body.code, 'NOT_FOUND');
  assert.equal((await register(other.key, 'o1')).status, 200);

  // the developer can switch self-service removal off (per workspace): then it is refused, and the list says so
  const la = await mint(alice, { owner: 'eve-alice', max_servers: 2 });
  await register(la.key, 'a1');
  const viaAlice = (await call('POST', '/api/account/licenses', { key: la.key }, eve)).body;
  assert.equal(viaAlice.public_removal, true);
  assert.equal((await call('PUT', '/api/admin/settings', { public_removal: false }, alice)).status, 200);
  const off = await remove(la, viaAlice.servers[0].id);
  assert.equal(off.status, 409); assert.equal(off.body.code, 'DISABLED');
  assert.equal((await call('POST', '/api/public/remove', { key: la.key, serverId: viaAlice.servers[0].id })).body.code, 'DISABLED');
  const listed = (await call('GET', '/api/account', undefined, eve)).body.licenses;
  assert.equal(listed.find(l => l.id === la.id).public_removal, false);
  assert.equal(listed.find(l => l.id === lic.id).public_removal, true, 'the other developer\'s setting is separate');
  assert.equal((await register(la.key, 'a1')).status, 200, 'and nothing was removed');

  // removal works on licenses issued to the buyer's email as well
  const mailed = await mint(boss, { owner: 'mail' });
  sql("UPDATE licenses SET buyer_email='eve@buyers.io' WHERE id=?", mailed.id);
  await register(mailed.key, 'm1');
  const ms = (await call('GET', '/api/account', undefined, eve)).body.licenses.find(l => l.id === mailed.id).servers[0];
  assert.equal((await remove(mailed, ms.id)).status, 200);
});

test('buyers are isolated from each other and from the creators\' admin API', async () => {
  at(8);
  const ann = await buyer('iso-ann'), ben = await buyer('iso-ben');
  const la = await mint(alice, { owner: 'ann', max_servers: 2 }), lb = await mint(bob, { owner: 'ben', max_servers: 2 });
  await register(la.key, 'ia'); await register(lb.key, 'ib');
  const sa = (await call('POST', '/api/account/licenses', { key: la.key }, ann)).body.servers[0];
  const sb = (await call('POST', '/api/account/licenses', { key: lb.key }, ben)).body.servers[0];

  assert.deepEqual((await call('GET', '/api/account', undefined, ann)).body.licenses.map(l => l.key), [la.key]);
  assert.deepEqual((await call('GET', '/api/account', undefined, ben)).body.licenses.map(l => l.key), [lb.key]);

  // ben tries every license id in the database, in every way an id is accepted
  const ids = rows('SELECT id FROM licenses').map(r => r.id).filter(id => id !== lb.id);
  assert.ok(ids.includes(la.id) && ids.length >= 5);
  for (const id of ids) assert.equal((await call('DELETE', `/api/account/licenses/${id}`, undefined, ben)).status, 404, `DELETE ${id}`);
  for (const id of ids.slice(0, 10)) {
    assert.equal((await call('POST', `/api/account/licenses/${id}/remove-server`, { serverId: sa.id }, ben)).status, 404, `remove via ${id}`);
  }
  // ben's own license id with ann's server id: not found either, ann's server is safe
  const cross = await call('POST', `/api/account/licenses/${lb.id}/remove-server`, { serverId: sa.id }, ben);
  assert.equal(cross.status, 409); assert.equal(cross.body.code, 'NOT_FOUND');
  assert.equal((await register(la.key, 'ia')).status, 200, 'ann\'s server survived');
  assert.equal(rows('SELECT * FROM buyer_links WHERE license_id=?', la.id).length, 1, 'ann\'s link survived');
  assert.deepEqual((await call('GET', '/api/account', undefined, ann)).body.licenses.map(l => l.key), [la.key]);

  // a buyer account is no admin account, even for the very license it has linked
  for (const [m, p, b] of [['GET', '/api/admin/licenses'], ['GET', `/api/admin/licenses/${la.id}`], ['PATCH', `/api/admin/licenses/${la.id}`, { owner: 'x' }], ['DELETE', `/api/admin/licenses/${la.id}`],
    ['GET', '/api/admin/servers'], ['DELETE', `/api/admin/servers/${sa.id}`], ['GET', '/api/admin/stats'], ['GET', '/api/admin/settings'], ['POST', '/api/billing/portal'], ['GET', '/api/admin/audit']])
    assert.equal((await call(m, p, b, ann)).status, 401, `${m} ${p}`);

  // and a creator is only a buyer for what is linked or emailed to HER: her own workspace's licenses do not appear
  assert.deepEqual((await call('GET', '/api/account', undefined, alice)).body.licenses, [], 'alice owns la, but it is not in her buyer list');
  assert.equal((await call('POST', `/api/account/licenses/${lb.id}/remove-server`, { serverId: sb.id }, alice)).status, 404, 'and the buyer API gives a creator no reach into bob\'s workspace');
  assert.equal((await call('DELETE', `/api/admin/licenses/${lb.id}`, undefined, alice)).status, 404);
  const boss404 = await call('GET', '/api/account', undefined, boss);
  assert.deepEqual(boss404.body.licenses, [], 'not even the owner sees everything through the buyer API');

  // when the creator deletes the license it disappears from the buyer, links included
  assert.equal((await call('DELETE', `/api/admin/licenses/${la.id}`, undefined, alice)).status, 200);
  assert.deepEqual((await call('GET', '/api/account', undefined, ann)).body.licenses, []);
  assert.equal(rows('SELECT * FROM buyer_links WHERE license_id=?', la.id).length, 0);
});

test('identity is provider + provider id: same id elsewhere is a different person, and no email is needed', async () => {
  at(9);
  const lic = await mint(boss, { owner: 'identity' });
  const gh = forge({ p: 'github', id: '777', name: 'gh user', email: '', emails: [] });
  const dc = forge({ p: 'discord', id: '777', name: 'dc user', email: '', emails: [] });
  const gh2 = forge({ p: 'github', id: '777', name: 'renamed', email: 'new@mail.io', emails: ['new@mail.io'] });
  assert.equal((await call('POST', '/api/account/licenses', { key: lic.key }, gh)).status, 201, 'a Discord/GitHub account without a verified email can still link by key');
  assert.deepEqual((await call('GET', '/api/account', undefined, dc)).body.licenses, [], 'github:777 is not discord:777');
  assert.deepEqual((await call('GET', '/api/account', undefined, gh2)).body.licenses.map(l => l.key), [lic.key], 'same provider id, even with a new name and email');
  assert.equal((await call('GET', '/api/account', undefined, gh)).body.user.email, '');
  assert.deepEqual(rows("SELECT user_key FROM buyer_links WHERE license_id=?", lic.id).map(r => r.user_key), ['github:777']);
});

test('rate limits: per account and per address; one person cannot lock out another', async () => {
  // per account: 15 tries a minute, whatever the address
  at(10);
  const fast = await buyer('fast');
  for (let i = 0; i < 15; i++) assert.equal((await call('POST', '/api/account/licenses', { key: 'LX-AAAA-AAAA-AAAA-AAAA' }, fast)).status, 404, `try ${i + 1}`);
  const limited = await call('POST', '/api/account/licenses', { key: 'LX-AAAA-AAAA-AAAA-AAAA' }, fast);
  assert.equal(limited.status, 429); assert.match(limited.body.message, /Too many/);
  at(11);
  assert.equal((await call('POST', '/api/account/licenses', { key: 'LX-AAAA-AAAA-AAAA-AAAA' }, fast)).status, 429, 'a new address does not reset the account\'s limit');
  assert.equal((await call('POST', '/api/account/licenses', { key: 'LX-AAAA-AAAA-AAAA-AAAA' }, await buyer('calm'))).status, 404, 'somebody else is not affected');

  // per address: 40 tries a minute across all accounts behind it
  at(12);
  const crowd = [await buyer('crowd1'), await buyer('crowd2'), await buyer('crowd3')];
  const statuses = [];
  for (let i = 0; i < 41; i++) statuses.push((await call('POST', '/api/account/licenses', { key: 'LX-AAAA-AAAA-AAAA-AAAA' }, crowd[Math.floor(i / 15)])).status);
  assert.deepEqual(statuses.slice(0, 40).filter(s => s !== 404), []);
  assert.equal(statuses[40], 429, 'the 41st try from one address is refused although this account only made 11');
  at(13);
  assert.equal((await call('POST', '/api/account/licenses', { key: 'LX-AAAA-AAAA-AAAA-AAAA' }, crowd[2])).status, 404, 'from another address that account is fine');

  // removing servers is limited too (30 a minute)
  at(14);
  const rm = await buyer('remover');
  const lic = await mint(boss, { owner: 'rm' });
  await call('POST', '/api/account/licenses', { key: lic.key }, rm);
  for (let i = 0; i < 30; i++) assert.equal((await call('POST', `/api/account/licenses/${lic.id}/remove-server`, { serverId: 999999 }, rm)).status, 409);
  assert.equal((await call('POST', `/api/account/licenses/${lic.id}/remove-server`, { serverId: 999999 }, rm)).status, 429);
});

test('at most 100 licenses can be linked by key; the list shows at most 200, newest first', async () => {
  at(15);
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const keyOf = n => `LX-CAPS-${[15, 10, 5, 0].map(s => A[(n >> s) & 31]).join('')}-ZZZZ-ZZZZ`;
  const insert = side.prepare("INSERT INTO licenses (workspace_id, key, owner, buyer_email, created_at) VALUES (1, ?, 'bulk', ?, ?)");
  const ids = [];
  for (let n = 0; n < 101; n++) ids.push(Number(insert.run(keyOf(n), '', 1000 + n).lastInsertRowid));
  const cap = await buyer('capper');
  const link = side.prepare('INSERT INTO buyer_links (user_key, license_id, created_at) VALUES (?,?,1)');
  for (const id of ids.slice(0, 99)) link.run('google:g-capper@buyers.io', id);

  assert.equal((await call('POST', '/api/account/licenses', { key: keyOf(99) }, cap)).status, 201, 'the 100th');
  const over = await call('POST', '/api/account/licenses', { key: keyOf(100) }, cap);
  assert.equal(over.status, 409); assert.match(over.body.message, /100/);
  assert.equal((await call('POST', '/api/account/licenses', { key: keyOf(5) }, cap)).status, 200, 'one that is already linked is still fine at the cap');
  assert.equal(rows("SELECT * FROM buyer_links WHERE user_key='google:g-capper@buyers.io'").length, 100);
  assert.equal((await call('DELETE', `/api/account/licenses/${ids[0]}`, undefined, cap)).status, 200);
  assert.equal((await call('POST', '/api/account/licenses', { key: keyOf(100) }, cap)).status, 201, 'room again after an unlink');
  const mine = (await call('GET', '/api/account', undefined, cap)).body.licenses;
  assert.equal(mine.length, 100);
  assert.deepEqual(mine.map(l => l.id), [...mine.map(l => l.id)].sort((a, b) => b - a), 'newest first');

  // 205 licenses issued to one email address: the page lists the newest 200
  at(16);
  const big = await buyer('big');
  for (let n = 0; n < 205; n++) insert.run(keyOf(1000 + n), 'big@buyers.io', 5000 + n);
  const list = (await call('GET', '/api/account', undefined, big)).body.licenses;
  assert.equal(list.length, 200);
  assert.ok(list.every(l => l.via === 'email'));
  assert.equal(list[0].created_at, 5204); assert.equal(list[199].created_at, 5005);
});

test('the creator\'s audit log gets no buyer details: linking leaves no trace, removing a server is logged like on the public page', async () => {
  at(17);
  const zed = await buyer('zed');
  const lic = await mint(boss, { owner: 'zed' });
  await register(lic.key, 'z1', 'Zed Server');
  const server = (await call('POST', '/api/account/licenses', { key: lic.key }, zed)).body.servers[0];
  const noise = rows('SELECT COUNT(*) n FROM audit').at(0).n;
  for (let i = 0; i < 5; i++) { await call('DELETE', `/api/account/licenses/${lic.id}`, undefined, zed); await call('POST', '/api/account/licenses', { key: lic.key }, zed); }
  assert.equal(rows('SELECT COUNT(*) n FROM audit').at(0).n, noise, 'linking and unlinking never write to the audit log (so a buyer cannot flood it)');
  assert.equal((await call('POST', `/api/account/licenses/${lic.id}/remove-server`, { serverId: server.id }, zed)).status, 200);
  const entries = (await call('GET', '/api/admin/audit?limit=500', undefined, boss)).body.filter(a => a.target === lic.key && a.action === 'server.remove');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor, 'owner', 'same actor as the public page');
  assert.ok(!/@|zed@|buyers\.io|google/i.test(JSON.stringify(entries[0])), 'no name, email or provider of the buyer');
  assert.equal(rows("SELECT * FROM audit WHERE actor='buyer'").length, 0);
  // and another workspace's log never shows it
  assert.ok(!(await call('GET', '/api/admin/audit?limit=500', undefined, bob)).body.some(a => a.target === lic.key));
});

test('the pages exist, and sign-in lands on the page that was asked for (and nowhere else)', async () => {
  at(18);
  for (const path of ['/login', '/login/creator', '/login/buyer', '/account']) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path); assert.match(r.headers.get('content-type'), /text\/html/);
  }
  const landing = async next => (await login(googleUser('lander@buyers.io'), next)).location;
  assert.equal(await landing('/account'), '/account');
  assert.equal(await landing('/dashboard'), '/dashboard');
  assert.equal(await landing('/login/buyer'), '/login/buyer');
  assert.equal(await landing('/login/creator'), '/login/creator');
  assert.equal(await landing(undefined), '/');
  for (const evil of ['https://evil.example', '//evil.example', '/account/../admin', '/ACCOUNT', 'account', '/account?x=1']) assert.equal(await landing(evil), '/', evil);
});
