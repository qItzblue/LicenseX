import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A server behind ONE reverse proxy (TRUST_PROXY=1): the proxy appends the address it saw to X-Forwarded-For.
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-hard-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'secret-pw';
process.env.TRUST_PROXY = '1';
const { server } = await import('../server/index.js');
const { listEntries, injectFiles } = await import('../server/jarstamp.js');
let base, port, cookie;
after(() => server.close());
const call = (method, path, body, headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }));
before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { port = server.address().port; base = `http://127.0.0.1:${port}`; r(); }));
  const r = await call('POST', '/api/admin/login', { password: 'secret-pw' });
  cookie = r.headers.get('set-cookie').split(';')[0];
});

const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));

test('client address: the forged left side of X-Forwarded-For is ignored, the proxy-appended entry is used', async () => {
  // the attacker rotates the leftmost value on every try; the proxy always appends the same real address
  let last;
  for (let i = 0; i < 10; i++) last = await call('POST', '/api/admin/login', { password: 'wrong' }, { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7` });
  assert.equal(last.status, 429, 'the per-address login limit still applies');
  const audit = (await call('GET', '/api/admin/audit?limit=20', null, { Cookie: cookie })).body;
  const fails = audit.filter(a => a.action === 'login.fail');
  assert.ok(fails.length >= 5);
  assert.ok(fails.every(a => a.target === '203.0.113.7'), 'every failure is attributed to the address the proxy saw');
});

test('malformed cookies and URLs never cause a 500', async () => {
  const r = await call('GET', '/api/admin/stats', null, { Cookie: 'lx_admin=%E0%A4%A; lx_user=%; =x; novalue' });
  assert.equal(r.status, 401);
  const ok = await call('GET', '/api/auth/me', null, { Cookie: 'lx_user=%zz; lx_admin=%' });
  assert.equal(ok.status, 200);
  // a path that is not valid percent-encoding
  const status = await new Promise((res, rej) => request({ host: '127.0.0.1', port, path: '/%E0%A4%A', method: 'GET' }, r => { r.resume(); res(r.statusCode); }).on('error', rej).end());
  assert.equal(status, 400);
});

test('a bad re-upload never replaces the jar that is being served', async () => {
  const p = (await call('POST', '/api/admin/products', { name: 'Keep Me' }, { Cookie: cookie })).body;
  const up = (body, name = 'p.jar') => fetch(base + `/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': name }, body });
  assert.equal((await up(plugin)).status, 200);
  const dl = () => fetch(base + `/download/keep-me?token=${p.token}&nonce=n1`).then(async r => ({ status: r.status, buf: Buffer.from(await r.arrayBuffer()) }));
  const before = await dl();
  assert.equal(before.status, 200);

  assert.equal((await up(Buffer.from('this is not a zip file at all'))).status, 400);
  assert.equal((await up(plugin.subarray(0, 100))).status, 400, 'a truncated archive is refused too');
  assert.equal((await up(Buffer.alloc(0))).status, 400);

  const after = await dl();
  assert.equal(after.status, 200, 'the product is still downloadable');
  assert.deepEqual(listEntries(after.buf).filter(n => !n.startsWith('dev/licensex/') && n !== 'licensex.json').sort(),
    listEntries(plugin).sort(), 'and it is still the original plugin');
  const row = (await call('GET', '/api/admin/products', null, { Cookie: cookie })).body.find(x => x.id === p.id);
  assert.equal(row.has_file, 1);
  assert.equal(row.integration.ok, true);
});

test('HEAD on a download link answers without minting a license or counting a download', async () => {
  const p = (await call('POST', '/api/admin/products', { name: 'Head Test' }, { Cookie: cookie })).body;
  await fetch(base + `/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'h.jar' }, body: plugin });
  const licenses = async () => (await call('GET', '/api/admin/licenses', null, { Cookie: cookie })).body.length;
  const n0 = await licenses();
  const head = await fetch(base + `/download/head-test?token=${p.token}&nonce=abc`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await licenses(), n0, 'no license was created');
  assert.equal((await fetch(base + `/download/head-test?token=wrong`, { method: 'HEAD' })).status, 403, 'the token is still checked');
  const row = (await call('GET', '/api/admin/products', null, { Cookie: cookie })).body.find(x => x.id === p.id);
  assert.equal(row.downloads, 0);
  assert.equal((await fetch(base + `/download/head-test?token=${p.token}&nonce=abc`)).status, 200);
  assert.equal(await licenses(), n0 + 1, 'a real GET still issues one');
});

test('zip reader: a fake end record inside the comment is not trusted, and ZIP64 is told apart properly', () => {
  const eocd = plugin.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(plugin.readUInt16LE(eocd + 20), 0, 'fixture has no comment');
  // append a comment that contains a bogus end-record signature whose own comment length overruns the file
  const fake = Buffer.alloc(22); fake.writeUInt32LE(0x06054b50, 0); fake.writeUInt16LE(5, 20);
  const withComment = Buffer.concat([plugin, fake]); withComment.writeUInt16LE(fake.length, eocd + 20);
  assert.deepEqual(listEntries(withComment), listEntries(plugin));
  assert.ok(injectFiles(withComment, [{ name: 'x.txt', content: 'x' }]).length > plugin.length);

  // a ZIP64 locator right before the end record means "not supported" (and a plain archive is fine)
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50, 0);
  const z64 = Buffer.concat([plugin.subarray(0, eocd), locator, plugin.subarray(eocd)]);
  assert.throws(() => injectFiles(z64, [{ name: 'x.txt', content: 'x' }]), /ZIP64/);
  assert.doesNotThrow(() => injectFiles(plugin, [{ name: 'x.txt', content: 'x' }]));
});
