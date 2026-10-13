// End-to-end proof on a REAL Paper server (not part of `npm test`; needs Java 17+ and a Paper jar):
//   PAPER_JAR=/path/to/paper-1.20.4.jar node test/paper-e2e.mjs
// A plugin that knows nothing about LicenseX is uploaded, downloaded as a licensed buyer, started on Paper,
// then blocked in the admin and must shut itself down, and must refuse to start after a restart.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAPER = process.env.PAPER_JAR;
if (!PAPER) { console.log('SKIP: set PAPER_JAR to a Paper server jar'); process.exit(0); }

const work = mkdtempSync(join(tmpdir(), 'lx-paper-'));
process.env.LICENSEX_DATA = join(work, 'data');
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
const { server } = await import('../server/index.js');
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const step = m => console.log(`\n== ${m}`);

const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };

step('upload a plugin that has no LicenseX code');
const original = readFileSync(join(HERE, 'fixtures/hello/hello-plugin.jar'));
const product = (await api('POST', '/api/admin/products', { name: 'Hello' })).body;
const up = await fetch(`${base}/api/admin/products/${product.id}/file`, { method: 'POST', headers: { Cookie: cookie, 'X-Filename': 'hello-plugin.jar' }, body: original });
const upBody = await up.json();
assert.equal(upBody.integration.ok, true, 'jar should be wrappable: ' + JSON.stringify(upBody.integration));
console.log('integration:', upBody.integration);

step('buyer 77 downloads it');
const dl = await fetch(`${base}/download/hello?token=${product.token}&user=77&name=Steve`);
assert.equal(dl.status, 200);
const wrapped = Buffer.from(await dl.arrayBuffer());
assert.notDeepEqual(wrapped, original);
const dl2 = Buffer.from(await (await fetch(`${base}/download/hello?token=${product.token}&user=77&name=Steve`)).arrayBuffer());
assert.equal((await api('GET', '/api/admin/licenses?q=Steve')).body.length, 1, 'same buyer, two downloads => one license');

// --- Paper helpers
const runDir = join(work, 'paper');
function setup() {
  mkdirSync(join(runDir, 'plugins'), { recursive: true });
  copyFileSync(PAPER, join(runDir, 'paper.jar'));
  writeFileSync(join(runDir, 'eula.txt'), 'eula=true\n');
  writeFileSync(join(runDir, 'server.properties'), 'online-mode=false\nserver-port=25599\nlevel-type=flat\nview-distance=2\nsimulation-distance=2\nspawn-protection=0\nmax-players=2\nmotd=LicenseX test\n');
  writeFileSync(join(runDir, 'plugins/Hello.jar'), wrapped);
}
function start() {
  const proc = spawn('java', ['-Xmx1G', '-Dcom.mojang.eula.agree=true', '-jar', 'paper.jar', '--nogui'], { cwd: runDir });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  const exited = new Promise(r => proc.on('exit', r));
  return {
    get log() { return log; },
    async waitFor(re, ms) { const t = Date.now(); while (!re.test(log)) { if (Date.now() - t > ms) throw new Error(`timeout waiting for ${re}\n--- log tail ---\n${log.split('\n').slice(-40).join('\n')}`); await new Promise(r => setTimeout(r, 500)); } },
    async stop() { proc.stdin.write('stop\n'); await Promise.race([exited, new Promise(r => setTimeout(r, 30000))]); proc.kill(); },
  };
}
const lines = log => log.split('\n').filter(l => /LicenseX|HELLO/.test(l)).map(l => l.replace(/^\[[\d:]+ /, '[').trim());

setup();
step('boot 1: licensed buyer starts a server with the wrapped plugin');
let s = start();
try {
  await s.waitFor(/HELLO_ENABLED/, 180000);
  const L = lines(s.log); console.log(L.join('\n'));
  const iVerified = s.log.indexOf('verified'), iEnabled = s.log.indexOf('HELLO_ENABLED');
  assert.ok(iVerified > 0 && iVerified < iEnabled, 'license must be verified BEFORE the original plugin enables');
  assert.match(s.log, /same-instance=true/, 'original plugin still sees itself as the plugin instance');
  assert.match(s.log, /greeting=hi from the original plugin/, 'original plugin resources/config still work');
  await s.waitFor(/HELLO_TICK/, 20000);
  const servers = (await api('GET', '/api/admin/servers')).body;
  assert.equal(servers.length, 1);
  assert.equal(servers[0].port, 25599);
  assert.equal(servers[0].name, 'LicenseX test');
  console.log('LicenseX sees the server:', servers[0].name, '@', servers[0].ip + ':' + servers[0].port);

  step('admin blocks the license; the running plugin must shut itself down');
  const lic = (await api('GET', '/api/admin/licenses?q=Steve')).body[0];
  await api('PATCH', `/api/admin/licenses/${lic.id}`, { status: 'blocked', block_reason: 'Chargeback' });
  await s.waitFor(/HELLO_DISABLED/, 120000);
  assert.match(s.log, /Chargeback/);
  console.log(lines(s.log).slice(-4).join('\n'));
} finally { await s.stop(); }

step('boot 2: the blocked license must not start the plugin at all');
s = start();
try {
  await s.waitFor(/Done \(/, 180000);
  await new Promise(r => setTimeout(r, 2000));
  assert.doesNotMatch(s.log, /HELLO_ENABLED/);
  assert.match(s.log, /Chargeback/);
  console.log(lines(s.log).join('\n'));
} finally { await s.stop(); }

step('boot 3: BuiltByBit flow. Upload the BuiltByBit build; BuiltByBit writes the buyer key into the class');
const { readEntry, listEntries, injectFiles } = await import('../server/jarstamp.js');
const { mapUtf8 } = await import('../server/classfile.js');
const bbbBuild = Buffer.from(await (await fetch(`${base}/api/admin/products/${product.id}/bbb-build`, { headers: { Cookie: cookie } })).arrayBuffer());
const settings = (await api('GET', '/api/admin/settings')).body;
const bbbKey = await (await fetch(base + '/api/v1/builtbybit/license', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ secret: settings.bbb_secret, user_id: '88', resource_id: '5' }) })).text();
assert.match(bbbKey, /^LX-/);
const gateName = listEntries(bbbBuild).find(n => /\/Gate\.class$/.test(n));
const gate = readEntry(bbbBuild, gateName);
assert.ok(gate.includes('%%__BBB_LICENSE__%%'), 'the BuiltByBit build must contain the placeholder text');
assert.equal(JSON.parse(readEntry(bbbBuild, 'licensex.json')).key, '', 'no key baked in');
const delivered = injectFiles(bbbBuild, [{ name: gateName, content: mapUtf8(gate, s => s === '%%__BBB_LICENSE__%%' ? bbbKey : s) }]);
writeFileSync(join(runDir, 'plugins/Hello.jar'), delivered);
s = start();
try {
  await s.waitFor(/HELLO_ENABLED/, 180000);
  assert.match(s.log, new RegExp(`License ${bbbKey} verified`));
  console.log(lines(s.log).join('\n'));
  const owner = (await api('GET', '/api/admin/licenses?q=BuiltByBit')).body.find(l => l.key === bbbKey);
  assert.ok(owner, 'the BuiltByBit buyer license exists in the admin');
} finally { await s.stop(); }

console.log('\nPASS: the wrapped plugin is license-gated on a real Paper server');
server.close();
process.exit(0);
