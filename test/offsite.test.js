import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { signS3, encrypt, decrypt, isEncrypted, createOffsite, DISCORD_MAX } from '../server/offsite.js';
import { listEntries, readEntry } from '../server/jarstamp.js';

test('S3 signing matches Amazon\'s published example (GET object, signature version 4)', () => {
  const h = signS3({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' },
    accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') });
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('encrypted backups only open with the right password', () => {
  const data = randomBytes(5000), sealed = encrypt(data, 'hunter2');
  assert.ok(isEncrypted(sealed) && !isEncrypted(data));
  assert.ok(!sealed.includes(data.subarray(0, 64)), 'the contents are not readable');
  assert.deepEqual(decrypt(sealed, 'hunter2'), data);
  assert.throws(() => decrypt(sealed, 'wrong'), /password is wrong/);
  assert.throws(() => decrypt(sealed, ''), /LICENSEX_BACKUP_PASSWORD/);
  sealed[sealed.length - 1] ^= 1;
  assert.throws(() => decrypt(sealed, 'hunter2'), /wrong|damaged/, 'tampering is detected');
});

// A tiny S3: checks every request's signature with the same secret, keeps objects in memory.
async function fakeS3({ access = 'AK', secret = 'SK', region = 'auto' } = {}) {
  const objects = new Map(), log = [];
  const srv = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks), url = `http://${req.headers.host}${req.url}`;
    const expect = signS3({ method: req.method, url, body, accessKey: access, secretKey: secret, region, date: new Date(req.headers['x-amz-date'].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z')),
      headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {} });
    log.push(`${req.method} ${req.url}`);
    if (expect.authorization !== req.headers.authorization) { res.writeHead(403); return res.end('<Error>SignatureDoesNotMatch</Error>'); }
    if (req.method === 'PUT') { objects.set(decodeURIComponent(req.url), body); res.writeHead(200); return res.end(); }
    const o = objects.get(decodeURIComponent(req.url));
    if (!o) { res.writeHead(404); return res.end('<Error>NoSuchKey</Error>'); }
    res.writeHead(200); res.end(o);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { objects, log, endpoint: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
async function fakeDiscord() {
  const posts = [];
  const srv = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
    const file = form.get('files[0]');
    posts.push({ text: JSON.parse(form.get('payload_json')).content, name: file.name, file: Buffer.from(await file.arrayBuffer()) });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { posts, url: `http://127.0.0.1:${srv.address().port}/api/webhooks/1/x`, close: () => srv.close() };
}

test('only changed data is sent; Discord gets a smaller copy when the plugins do not fit', async () => {
  const s3 = await fakeS3(), dc = await fakeDiscord();
  after(() => { s3.close(); dc.close(); });
  let digest = 'a', zip = Buffer.from('full'), small = Buffer.from('small');
  const off = createOffsite({ anyWebhook: true, snapshot: () => ({ zip, digest, small }),
    config: { s3: { endpoint: s3.endpoint, bucket: 'bk', accessKey: 'AK', secretKey: 'SK' }, discord: dc.url, password: '', everyMinutes: 60, discordEveryMinutes: 360 } });
  assert.deepEqual((await off.run()).results, { s3: 'sent', discord: 'sent' });
  assert.deepEqual(s3.objects.get('/bk/licensex/latest.zip'), zip);
  assert.ok([...s3.objects.keys()].some(k => /^\/bk\/licensex\/daily\/\d{4}-\d\d-\d\d\.zip$/.test(k)));
  assert.deepEqual((await off.run()).results, { s3: 'unchanged', discord: 'not due yet' });
  digest = 'b';
  assert.deepEqual((await off.run()).results, { s3: 'sent', discord: 'not due yet' }, 'Discord is not spammed on every change');
  zip = Buffer.alloc(DISCORD_MAX + 10);
  const r = await off.run({ reason: 'shutdown', force: true });
  assert.match(r.results.discord, /without the plugin files/);
  assert.deepEqual(dc.posts.at(-1).file, small);
  assert.equal(dc.posts.length, 2);
  assert.ok(off.status().s3.last_ok && !off.status().s3.last_error);

  // wrong credentials: reported, not thrown
  const bad = createOffsite({ snapshot: () => ({ zip, digest, small }), config: { s3: { endpoint: s3.endpoint, bucket: 'bk', accessKey: 'AK', secretKey: 'nope' }, discord: '', password: '', everyMinutes: 60, discordEveryMinutes: 360 } });
  const b = await bad.run();
  assert.equal(b.ok, false); assert.match(b.results.s3, /403/); assert.match(bad.status().s3.last_error, /SignatureDoesNotMatch/);
  // a Discord address that is not Discord is refused outright
  const fake = createOffsite({ snapshot: () => ({}), config: { s3: {}, discord: 'https://evil.example/api/webhooks/1/x', password: '', everyMinutes: 60, discordEveryMinutes: 360 } });
  assert.equal(fake.enabled, false); assert.equal(fake.status().discord_invalid, true);
});

// --- the real server: back up, get wiped, come back --------------------------------------------------------------------
function startServer(dataDir, env) {
  const child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: '0', LICENSEX_DATA: dataDir, LICENSEX_ADMIN_PASSWORD: 'pw', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    const on = d => { out += d; const m = /listening on http:\/\/localhost:(\d+)/.exec(out); if (m) resolve(`http://127.0.0.1:${m[1]}`); };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', code => reject(new Error(`server exited (${code}): ${out}`)));
  });
  return { child, ready, output: () => out, exited: new Promise(r => child.on('exit', r)) };
}

test('a wiped server restores itself from the off-site copy, and a stopping server sends a last copy', async () => {
  const s3 = await fakeS3();
  after(() => s3.close());
  const env = { LICENSEX_BACKUP_S3_ENDPOINT: s3.endpoint, LICENSEX_BACKUP_S3_BUCKET: 'bk', LICENSEX_BACKUP_S3_ACCESS_KEY: 'AK', LICENSEX_BACKUP_S3_SECRET_KEY: 'SK', LICENSEX_BACKUP_PASSWORD: 'pw2' };
  const first = startServer(mkdtempSync(join(tmpdir(), 'lx-off1-')), env);
  const base = await first.ready;
  const cookie = 'lx_admin=' + (await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"pw"}' })).headers.getSetCookie()[0].split(';')[0].split('=')[1];
  const api = (method, path, body) => fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json());
  const one = await api('POST', '/api/admin/licenses', { owner: 'before-backup' });
  assert.deepEqual((await api('POST', '/api/admin/offsite/run')).results, { s3: 'sent' });
  const sealed = s3.objects.get('/bk/licensex/latest.zip.enc');
  assert.ok(sealed && isEncrypted(sealed), 'stored encrypted');
  assert.ok(listEntries(decrypt(sealed, 'pw2')).includes('licensex.db'));
  // a change after the last scheduled copy, then the host stops the server
  const two = await api('POST', '/api/admin/licenses', { owner: 'just-before-stop' });
  first.child.kill('SIGTERM');
  assert.equal(await first.exited, 0);
  assert.match(first.output(), /last off-site backup/);

  // a brand new, empty disk
  const dir2 = mkdtempSync(join(tmpdir(), 'lx-off2-'));
  const second = startServer(dir2, env);
  const base2 = await second.ready;
  after(() => second.child.kill());
  assert.match(second.output(), /restored the latest off-site backup/);
  for (const lic of [one, two]) {
    const r = await fetch(base2 + '/api/public/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: lic.key }) });
    assert.equal(r.status, 200, `${lic.owner} came back`);
  }
  assert.ok(existsSync(join(dir2, 'licensex.db')));

  // without the right password it does not restore over anything, and copies stay paused
  const third = startServer(mkdtempSync(join(tmpdir(), 'lx-off3-')), { ...env, LICENSEX_BACKUP_PASSWORD: 'other' });
  await third.ready;
  after(() => third.child.kill());
  assert.match(third.output(), /Could not restore the off-site backup: The backup password is wrong/);
  assert.deepEqual(s3.objects.get('/bk/licensex/latest.zip.enc'), s3.objects.get('/bk/licensex/latest.zip.enc'));
  const before = s3.log.filter(l => l.startsWith('PUT')).length;
  third.child.kill('SIGTERM'); await third.exited;
  assert.equal(s3.log.filter(l => l.startsWith('PUT')).length, before, 'a server that could not restore never overwrites the good copy');
});
