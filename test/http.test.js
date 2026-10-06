import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'secret-pw';
const { server } = await import('../server/index.js');
let base;
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => server.close());

const call = (method, path, body, cookie) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }));

test('end to end: claim -> plugin -> portal -> admin', async () => {
  assert.equal((await call('GET', '/api/admin/licenses')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  const { cookie } = await call('POST', '/api/admin/login', { password: 'secret-pw' });
  assert.ok(cookie);

  const { body: c } = await call('POST', '/api/v1/claim', { nonce: 'dl-1', user: 'steve' });
  const key = c.key;
  assert.equal((await call('POST', '/api/v1/claim', { nonce: 'dl-1' })).body.key, key);

  assert.equal((await call('POST', '/api/v1/validate', { key, instanceId: 'srv-1', name: 'Lobby', port: 25565 })).status, 200);
  assert.equal((await call('POST', '/api/v1/validate', { key, instanceId: 'srv-2', name: 'Pirate' })).body.code, 'LIMIT_REACHED');

  const view = (await call('POST', '/api/public/lookup', { key: key.toLowerCase() })).body;
  assert.equal(view.used, 1); assert.match(view.servers[0].ip, /\.x$/);
  assert.equal((await call('POST', '/api/public/lookup', { key: 'LX-AAAA-AAAA-AAAA-AAAA' })).status, 404);

  // admin raises limit, second server joins
  const lic = (await call('GET', '/api/admin/licenses?q=steve', null, cookie)).body[0];
  await call('PATCH', `/api/admin/licenses/${lic.id}`, { max_servers: 2 }, cookie);
  assert.ok((await call('POST', '/api/v1/validate', { key, instanceId: 'srv-2' })).body.ok);

  // admin disables server 2, blocks license
  const srv = (await call('GET', '/api/admin/servers', null, cookie)).body.find(s => s.instance_id === 'srv-2');
  await call('PATCH', `/api/admin/servers/${srv.id}`, { status: 'disabled' }, cookie);
  assert.equal((await call('POST', '/api/v1/validate', { key, instanceId: 'srv-2' })).body.code, 'SERVER_DISABLED');
  await call('PATCH', `/api/admin/licenses/${lic.id}`, { status: 'blocked', block_reason: 'refund' }, cookie);
  assert.equal((await call('POST', '/api/v1/validate', { key, instanceId: 'srv-1' })).body.code, 'LICENSE_BLOCKED');
  assert.equal((await call('GET', '/api/admin/stats', null, cookie)).status, 200);
});

test('products: upload a jar, download stamps a license per download nonce', async () => {
  const { listEntries } = await import('../server/jarstamp.js');
  const emptyZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
  const { cookie } = await call('POST', '/api/admin/login', { password: 'secret-pw' });

  const p = (await call('POST', '/api/admin/products', { name: 'My Plugin' }, cookie)).body;
  assert.equal(p.slug, 'my-plugin');
  assert.match(p.builtbybit_url, /nonce=%%__NONCE__%%/);

  // raw binary upload (not JSON)
  const up = await fetch(base + `/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'MyPlugin.jar' }, body: emptyZip });
  assert.equal((await up.json()).has_file, 1);

  const token = p.token;
  const dl = (q) => fetch(base + `/download/my-plugin?${q}`).then(async r => ({ status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }));

  assert.equal((await dl('token=wrong')).status, 403);
  const d1 = await dl(`token=${token}&nonce=buyer-1&user=bob`);
  assert.equal(d1.status, 200);
  assert.equal(d1.type, 'application/java-archive');
  assert.ok(listEntries(d1.buf).includes('licensex.json'));

  const countFor = async () => (await call('GET', '/api/admin/licenses', null, cookie)).body.filter(l => l.product === 'My Plugin').length;
  await dl(`token=${token}&nonce=buyer-1&user=bob`); // same buyer, same download -> no new license
  assert.equal(await countFor(), 1);
  await dl(`token=${token}&nonce=buyer-2&user=sue`); // different buyer -> new license
  assert.equal(await countFor(), 2);

  // disabling the product blocks downloads
  await call('PATCH', `/api/admin/products/${p.id}`, { enabled: false }, cookie);
  assert.equal((await dl(`token=${token}&nonce=buyer-3`)).status, 404);
});
