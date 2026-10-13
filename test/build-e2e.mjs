// Real builds through the API (needs a JDK, Maven and/or Gradle, and internet to fetch dependencies):
//   npm run test:build
import { mkdtempSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-build-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
const m2 = join(homedir(), '.m2', 'repository');
if (existsSync(m2)) process.env.LICENSEX_BUILD_M2 = m2;   // reuse downloaded dependencies to save time (optional)
const { server } = await import('../server/index.js');
const { injectFiles, listEntries, readEntry } = await import('../server/jarstamp.js');
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const cookie = (await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) })).headers.get('set-cookie').split(';')[0];
const api = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const step = m => console.log(`\n== ${m}`);

const EMPTY = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
const walk = (d, o = []) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, o) : o.push(p); } return o; };
const zipDir = (dir, top) => injectFiles(EMPTY, walk(dir).map(p => ({ name: `${top}/${relative(dir, p).split(sep).join('/')}`, content: readFileSync(p) })));
const upload = (zip, name) => fetch(base + '/api/admin/builds', { method: 'POST', headers: { Cookie: cookie, 'X-Filename': name }, body: zip }).then(async r => ({ status: r.status, body: await r.json() }));
async function waitDone(id, ms = 8 * 60 * 1000) {
  const t = Date.now();
  for (;;) {
    const j = (await api('GET', `/api/admin/builds/${id}`)).body;
    if (j.status === 'done' || j.status === 'failed') return j;
    if (Date.now() - t > ms) throw new Error('build timed out:\n' + j.log.slice(-2000));
    await new Promise(r => setTimeout(r, 1500));
  }
}

step('tools on this machine');
const tools = (await api('GET', '/api/admin/builds/tools')).body;
console.log(tools);
assert.ok(tools.java, 'needs a JDK to run this test');

async function buildFixture(dirName, expectKind, pluginName) {
  step(`${expectKind}: upload ${dirName} as a zip, inspect, build`);
  const up = await upload(zipDir(join(HERE, 'fixtures', dirName), dirName), dirName + '.zip');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const rep = up.body.report;
  assert.equal(rep.kind, expectKind); assert.equal(rep.root, dirName);
  assert.equal(rep.plugin.name, pluginName); assert.equal(rep.plugin.main, 'com.acme.hello.HelloPlugin'); assert.equal(rep.mainFound, true);
  assert.equal(rep.java, '17'); assert.equal(rep.needsTrust, false); assert.deepEqual(rep.deps, ['paper-api']);
  assert.equal(up.body.status, 'inspected');

  const start = await api('POST', `/api/admin/builds/${up.body.id}/build`, {});
  assert.equal(start.status, 202, JSON.stringify(start.body));
  const second = await api('POST', `/api/admin/builds/${up.body.id}/build`, {});
  assert.equal(second.status, 409, 'cannot start the same build twice');
  const done = await waitDone(up.body.id);
  assert.equal(done.status, 'done', done.error + '\n' + done.log.slice(-2500));
  console.log(`built ${done.jar.name} (${done.jar.size} bytes), main=${done.jar.plugin.main}`);
  assert.equal(done.jar.plugin.main, 'com.acme.hello.HelloPlugin');

  const jar = Buffer.from(await (await fetch(`${base}/api/admin/builds/${up.body.id}/jar`, { headers: { Cookie: cookie } })).arrayBuffer());
  assert.ok(listEntries(jar).includes('plugin.yml') && listEntries(jar).includes('com/acme/hello/HelloPlugin.class'));
  assert.match(readEntry(jar, 'plugin.yml').toString(), new RegExp(`name: ${pluginName}`));
  const cls = readEntry(jar, 'com/acme/hello/HelloPlugin.class');
  assert.equal(cls.readUInt16BE(6), 61, 'compiled for Java 17');
  assert.ok(!/LICENSEX|pw/.test(done.log), 'no secrets leaked into the build log');
  return { id: up.body.id, jar };
}

const mvn = tools.maven ? await buildFixture('hello-maven', 'maven', 'HelloMaven') : null;
const gr = tools.gradle ? await buildFixture('hello-gradle', 'gradle', 'HelloGradle') : null;
if (!mvn && !gr) throw new Error('neither Maven nor Gradle is installed');

const built = mvn || gr;
step('use the built jar as a product: it is analysed and a buyer gets a wrapped copy');
const prod = await api('POST', `/api/admin/builds/${built.id}/product`, { name: 'Built From Source' });
assert.equal(prod.status, 200, JSON.stringify(prod.body));
assert.equal(prod.body.has_file, 1); assert.equal(prod.body.integration.ok, true); assert.equal(prod.body.integration.main, 'com.acme.hello.HelloPlugin');
const dl = Buffer.from(await (await fetch(`${base}/download/${prod.body.slug}?token=${prod.body.token}&user=42`)).arrayBuffer());
assert.ok(listEntries(dl).some(n => /^dev\/licensex\/w[0-9a-f]{8}\/Wrapper\.class$/.test(n)), 'download is wrapped');
const again = await api('POST', `/api/admin/builds/${built.id}/product`, { productId: prod.body.id });
assert.equal(again.status, 200, 'can also replace an existing product file');

step('a project that does not compile: fails cleanly, with the compiler output, and no jar');
const broken = zipDir(join(HERE, 'fixtures', 'hello-maven'), 'broken');
const bz = injectFiles(broken, [{ name: 'broken/src/main/java/com/acme/hello/HelloPlugin.java', content: 'package com.acme.hello; public class HelloPlugin { this is not java }' }]);
const bu = await upload(bz, 'broken.zip');
assert.equal(bu.status, 201);
if (tools.maven) {
  await api('POST', `/api/admin/builds/${bu.body.id}/build`, {});
  const bd = await waitDone(bu.body.id);
  assert.equal(bd.status, 'failed'); assert.match(bd.error, /build failed/i); assert.match(bd.log, /ERROR/); assert.equal(bd.jar, null);
  assert.equal((await fetch(`${base}/api/admin/builds/${bu.body.id}/jar`, { headers: { Cookie: cookie } })).status, 404);
  console.log('compiler said:', (bd.log.match(/\[ERROR\][^\n]*HelloPlugin\.java[^\n]*/) || ['(see log)'])[0].slice(0, 140));
}

step('risky project: refused until the person confirms they trust it');
const risky = injectFiles(zipDir(join(HERE, 'fixtures', 'hello-maven'), 'risky'), [{ name: 'risky/src/main/java/com/acme/hello/Evil.java', content: 'package com.acme.hello; class Evil { void x() throws Exception { Runtime.getRuntime().exec("id"); } }' }]);
const ru = await upload(risky, 'risky.zip');
assert.equal(ru.body.report.needsTrust, true);
assert.ok(ru.body.report.findings.some(f => f.id === 'exec'));
const refused = await api('POST', `/api/admin/builds/${ru.body.id}/build`, {});
assert.equal(refused.status, 400); assert.match(refused.body.message, /trust/i);
assert.equal((await api('GET', `/api/admin/builds/${ru.body.id}`)).body.status, 'inspected', 'nothing was started');

step('guard rails: auth, bad zips');
assert.equal((await fetch(base + '/api/admin/builds')).status, 401);
assert.equal((await fetch(base + '/api/admin/builds', { method: 'POST', body: Buffer.from('x') })).status, 401);
assert.equal((await upload(Buffer.from('not a zip'), 'x.zip')).status, 400);
assert.equal((await api('DELETE', `/api/admin/builds/${ru.body.id}`)).status, 200);
assert.equal((await api('GET', `/api/admin/builds/${ru.body.id}`)).status, 404);

console.log('\nPASS: source zip -> inspection -> real build -> jar -> product -> wrapped download');
server.close();
process.exit(0);
