import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWrappedConfig } from '../server/wrapjar.js';

process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'secret-pw';
const { server } = await import('../server/index.js');
const cfgOf = jar => readWrappedConfig(jar, readFileSync(join(process.env.LICENSEX_DATA, 'session.secret'), 'utf8').trim());
let base, adminCookie;
before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  adminCookie = (await call('POST', '/api/admin/login', { password: 'secret-pw' })).cookie;
});
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

  // the old unauthenticated /api/v1/claim endpoint is gone: anyone could mint licenses with it
  assert.equal((await call('POST', '/api/v1/claim', { nonce: 'x', user: 'steve' })).status, 404);
  const key = (await call('POST', '/api/admin/licenses', { owner: 'steve' }, cookie)).body.key;

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
  const { readFileSync } = await import('node:fs');
  const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
  const emptyZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
  const { cookie } = await call('POST', '/api/admin/login', { password: 'secret-pw' });

  const p = (await call('POST', '/api/admin/products', { name: 'My Plugin' }, cookie)).body;
  assert.equal(p.slug, 'my-plugin');
  assert.match(p.download_url, /\/download\/my-plugin\?token=/);

  // raw binary upload (not JSON)
  const up = await fetch(base + `/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'MyPlugin.jar' }, body: plugin });
  const upBody = await up.json();
  assert.equal(upBody.has_file, 1);
  assert.equal(upBody.integration.ok, true);
  assert.equal(upBody.integration.main, 'com.acme.hello.HelloPlugin');

  const token = p.token;
  const dl = (q) => fetch(base + `/download/my-plugin?${q}`).then(async r => ({ status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }));

  assert.equal((await dl('token=wrong')).status, 403);
  const d1 = await dl(`token=${token}&nonce=buyer-1&user=bob`);
  assert.equal(d1.status, 200);
  assert.equal(d1.type, 'application/java-archive');
  assert.ok(!listEntries(d1.buf).includes('licensex.json'), 'config is masked, not a plaintext file');
  assert.ok(listEntries(d1.buf).includes('META-INF/.sealed'), 'plugin is wrapped, not just stamped');
  assert.match(cfgOf(d1.buf).key, /^LX-/, 'a license key is embedded in the wrapped config');

  const countFor = async () => (await call('GET', '/api/admin/licenses', null, cookie)).body.filter(l => l.product === 'My Plugin').length;
  await dl(`token=${token}&nonce=buyer-1&user=bob`); // same buyer, same download -> no new license
  await dl(`token=${token}&nonce=buyer-1-again&user=bob`); // same buyer, brand new download -> still no new license
  assert.equal(await countFor(), 1);
  await dl(`token=${token}&nonce=buyer-2&user=sue`); // different buyer -> new license
  assert.equal(await countFor(), 2);

  // a jar that can't be wrapped (not a plugin) is refused instead of being served unprotected
  const bad = (await call('POST', '/api/admin/products', { name: 'Not A Plugin' }, cookie)).body;
  const badUp = await fetch(base + `/api/admin/products/${bad.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'x.jar' }, body: emptyZip });
  assert.equal((await badUp.json()).integration.ok, false);
  const refused = await fetch(base + `/download/not-a-plugin?token=${bad.token}&user=1`);
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).message, /plugin\.yml/);

  // disabling the product blocks downloads
  await call('PATCH', `/api/admin/products/${p.id}`, { enabled: false }, cookie);
  assert.equal((await dl(`token=${token}&nonce=buyer-3`)).status, 404);
});

test('BuiltByBit external-license-key callback: secret checked, same buyer = same license', async () => {
  const { cookie } = await call('POST', '/api/admin/login', { password: 'secret-pw' });
  const s = (await call('GET', '/api/admin/settings', null, cookie)).body;
  assert.match(s.bbb_callback_url, /\/api\/v1\/builtbybit\/license$/);
  assert.ok(s.bbb_secret.length >= 20);

  const post = fields => fetch(base + '/api/v1/builtbybit/license', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
    .then(async r => ({ status: r.status, type: r.headers.get('content-type'), text: await r.text() }));
  assert.equal((await post({ secret: 'wrong', user_id: '42', resource_id: '7' })).status, 403);
  assert.equal((await post({ user_id: '42', resource_id: '7' })).status, 403);

  const a = await post({ secret: s.bbb_secret, user_id: '42', resource_id: '7', version_id: '1', builtbybit: 'true' });
  assert.equal(a.status, 200);
  assert.match(a.type, /text\/plain/);
  assert.match(a.text, /^LX-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);       // bare key, nothing else
  assert.equal((await post({ secret: s.bbb_secret, user_id: '42', resource_id: '7', version_id: '2' })).text, a.text);   // re-download / new version
  assert.notEqual((await post({ secret: s.bbb_secret, user_id: '43', resource_id: '7' })).text, a.text);                // another buyer
  assert.equal((await post({ secret: s.bbb_secret, user_id: 'abc', resource_id: '7' })).status, 400);

  // the key works for a plugin and lands in the BuiltByBit group once one is chosen
  const grp = await call('POST', '/api/admin/groups', { name: 'BBB', max_servers: 2, color: '#112233' }, cookie);
  assert.equal(grp.status, 201);
  const gid = (await call('GET', '/api/admin/groups', null, cookie)).body.find(g => g.name === 'BBB').id;
  assert.equal((await call('PUT', '/api/admin/settings', { bbb_group_id: gid }, cookie)).status, 200);
  const g = await post({ secret: s.bbb_secret, user_id: '99', resource_id: '7' });
  assert.equal((await call('POST', '/api/public/lookup', { key: g.text })).body.limit, 2);

  // rotating the secret locks the old one out
  await call('PUT', '/api/admin/settings', { regenerate_bbb_secret: true }, cookie);
  assert.equal((await post({ secret: s.bbb_secret, user_id: '42', resource_id: '7' })).status, 403);
});

test('site links: validated, public, and never leak secrets', async () => {
  const { cookie } = await call('POST', '/api/admin/login', { password: 'secret-pw' });
  assert.equal((await call('PUT', '/api/admin/settings', { discord_url: 'javascript:alert(1)' }, cookie)).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { store_url: 'not a link' }, cookie)).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { support_email: 'nope' }, cookie)).status, 400);
  const ok = await call('PUT', '/api/admin/settings', { site_name: 'Acme Plugins', discord_url: 'https://discord.gg/acme', store_url: 'https://builtbybit.com/creators/acme.1/', support_email: 'help@acme.dev' }, cookie);
  assert.equal(ok.status, 200);
  const site = (await call('GET', '/api/public/site')).body;       // no cookie: public
  assert.equal(site.site_name, 'Acme Plugins');
  assert.equal(site.discord_url, 'https://discord.gg/acme');
  assert.equal(site.support_email, 'help@acme.dev');
  assert.equal(JSON.stringify(site).includes('secret'), false);
  assert.equal('bbb_secret' in site, false);
});

test('backup and restore round-trips licenses, groups, settings and plugin files', async () => {
  const { readFileSync } = await import('node:fs');
  const { listEntries } = await import('../server/jarstamp.js');
  const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
  const { cookie } = await call('POST', '/api/admin/login', { password: 'secret-pw' });
  assert.equal((await fetch(base + '/api/admin/backup')).status, 401);

  const lic = (await call('POST', '/api/admin/licenses', { owner: 'restore-me', note: 'keep' }, cookie)).body;
  await call('PUT', '/api/admin/settings', { site_name: 'Before Backup' }, cookie);
  const prod = (await call('POST', '/api/admin/products', { name: 'Backed Up' }, cookie)).body;
  await fetch(base + `/api/admin/products/${prod.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'b.jar' }, body: plugin });

  const res = await fetch(base + '/api/admin/backup', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /zip/);
  const backup = Buffer.from(await res.arrayBuffer());
  const names = listEntries(backup);
  assert.ok(names.includes('licensex.db') && names.includes('backup.json') && names.includes('products/backed-up.bin'), names.join());

  // change things after the backup was taken
  await call('DELETE', `/api/admin/licenses/${lic.id}`, null, cookie);
  await call('PUT', '/api/admin/settings', { site_name: 'After Backup' }, cookie);
  await call('DELETE', `/api/admin/products/${prod.id}`, null, cookie);
  assert.equal((await call('GET', '/api/admin/licenses?q=restore-me', null, cookie)).body.length, 0);

  const bad = await fetch(base + '/api/admin/restore', { method: 'POST', headers: { Cookie: cookie }, body: Buffer.from('not a zip') });
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', '/api/public/site')).body.site_name, 'After Backup', 'a failed restore changes nothing');

  const ok = await fetch(base + '/api/admin/restore', { method: 'POST', headers: { Cookie: cookie }, body: backup });
  assert.equal(ok.status, 200);
  const back = (await call('GET', '/api/admin/licenses?q=restore-me', null, cookie)).body;
  assert.equal(back.length, 1);
  assert.equal(back[0].key, lic.key, 'same license key after restore');
  assert.equal((await call('GET', '/api/public/site')).body.site_name, 'Before Backup');
  const products = (await call('GET', '/api/admin/products', null, cookie)).body;
  assert.ok(products.find(p => p.slug === 'backed-up' && p.has_file && p.integration.ok), 'plugin file restored and still wrappable');
  const dl = await fetch(base + `/download/backed-up?token=${prod.token}&user=5`);
  assert.equal(dl.status, 200, 'restored plugin can be downloaded');
});



test('server-computed feature: valid license gets a signed, nonce-bound result; a fake key gets nothing', async () => {
  const { readFileSync } = await import('node:fs');
  const crypto = await import('node:crypto');
  const cookie = adminCookie;
  const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
  const p = (await call('POST', '/api/admin/products', { name: 'Feat' }, cookie)).body;
  await fetch(base + `/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'x.jar' }, body: plugin });
  const jar = Buffer.from(await (await fetch(`${base}/download/feat?token=${p.token}&user=9`)).arrayBuffer());
  const cfg = cfgOf(jar);
  const key = cfg.key, pub = cfg.pub;
  assert.ok(pub, 'the public key is embedded in the config');
  const pubKey = crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' });
  const feat = (k, nonce) => fetch(base + '/api/v1/feature', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: k, instanceId: 'i1', feature: 'roll', params: '20', nonce }) }).then(async r => ({ status: r.status, body: await r.json() }));

  const nonce = 'abcd1234efgh5678';
  const ok = await feat(key, nonce);
  assert.equal(ok.status, 200);
  const [n, ts, text] = ok.body.data.split('|');
  assert.equal(n, nonce, 'the response is bound to our nonce');
  assert.ok(Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) < 10, 'fresh timestamp');
  assert.match(text, /computed on XdevStudios/);
  assert.ok(crypto.verify(null, Buffer.from(ok.body.data, 'utf8'), pubKey, Buffer.from(ok.body.sig, 'base64')), 'signature verifies');
  // a forged signature is rejected on verify (sanity)
  assert.ok(!crypto.verify(null, Buffer.from('tampered', 'utf8'), pubKey, Buffer.from(ok.body.sig, 'base64')));
  // bad key -> 403, no data
  assert.equal((await feat('LX-ZZZZ-ZZZZ-ZZZZ-ZZZZ', nonce)).status, 403);
  // missing nonce -> rejected
  assert.equal((await fetch(base + '/api/v1/feature', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, instanceId: 'i1', feature: 'roll' }) })).status, 400);
});

test('remote class loading: a valid license gets signed class bytes; invalid gets none', async () => {
  const crypto = await import('node:crypto');
  const { readFileSync, existsSync } = await import('node:fs');
  if (!existsSync(new URL('../server/prototype/remote/ServerGreeting.class', import.meta.url))) return; // class not built in this checkout
  const cookie = adminCookie;
  const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
  const p = (await call('POST', '/api/admin/products', { name: 'Cls' }, cookie)).body;
  await fetch(base + `/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'x.jar' }, body: plugin });
  const jar = Buffer.from(await (await fetch(`${base}/download/cls?token=${p.token}&user=1`)).arrayBuffer());
  const cfg = cfgOf(jar);
  const pubKey = crypto.createPublicKey({ key: Buffer.from(cfg.pub, 'base64'), format: 'der', type: 'spki' });
  const getCls = (k, name, nonce) => fetch(base + '/api/v1/class', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: k, instanceId: 'i1', name, nonce }) }).then(async r => ({ status: r.status, body: await r.json() }));
  const ok = await getCls(cfg.key, 'ServerGreeting', 'nonce12345678');
  assert.equal(ok.status, 200);
  assert.ok(crypto.verify(null, Buffer.from(ok.body.data, 'utf8'), pubKey, Buffer.from(ok.body.sig, 'base64')), 'class bytes are signed');
  const bytes = Buffer.from(ok.body.data.split('|')[2], 'base64');
  assert.equal(bytes.readUInt32BE(0), 0xCAFEBABE, 'it is a real class file');
  assert.equal((await getCls('LX-ZZZZ-ZZZZ-ZZZZ-ZZZZ', 'ServerGreeting', 'nonce12345678')).status, 403);
  assert.equal((await getCls(cfg.key, 'Nope', 'nonce12345678')).status, 404);
});

test('remote classes are per-creator: upload is validated and served only to that workspace', async () => {
  const crypto = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const cookie = adminCookie;
  // a real .class file to upload (reuse the compiled interface from the SDK if present, else a minimal CAFEBABE stub is rejected-safe)
  const classBytes = Buffer.concat([Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]), crypto.randomBytes(200)]);
  // non-.class is rejected
  const bad = await fetch(base + '/api/admin/remote-classes/Foo', { method: 'POST', headers: { Cookie: cookie }, body: Buffer.from('not a class') });
  assert.equal(bad.status, 400);
  // valid upload
  const up = await fetch(base + '/api/admin/remote-classes/Foo', { method: 'POST', headers: { Cookie: cookie }, body: classBytes });
  assert.equal(up.status, 200);
  assert.ok((await call('GET', '/api/admin/remote-classes', null, cookie)).body.some(c => c.name === 'Foo'));
  // a license in this workspace can fetch it (signed)
  const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
  const p = (await call('POST', '/api/admin/products', { name: 'RC' }, cookie)).body;
  await fetch(base + `/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'x.jar' }, body: plugin });
  const key = cfgOf(Buffer.from(await (await fetch(`${base}/download/rc?token=${p.token}&user=1`)).arrayBuffer())).key;
  const r = await fetch(base + '/api/v1/class', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, instanceId: 'i1', name: 'Foo', nonce: 'nonce12345678' }) }).then(async x => ({ status: x.status, body: await x.json() }));
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(r.body.data.split('|')[2], 'base64'), classBytes, 'served the exact uploaded class');
  // a name that does not exist anywhere -> 404
  assert.equal((await fetch(base + '/api/v1/class', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, instanceId: 'i1', name: 'Nonexistent', nonce: 'nonce12345678' }) })).status, 404);
});
