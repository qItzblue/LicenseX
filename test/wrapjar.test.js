import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wrapJar, checkWrappable, WrapError } from '../server/wrapjar.js';
import { injectFiles, listEntries, readEntry } from '../server/jarstamp.js';
import { readClass, mapUtf8 } from '../server/classfile.js';

const hello = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
const cfg = { url: 'https://lic.example', key: 'LX-AAAA-BBBB-CCCC-DDDD', product: 'Hello' };
const fails = (jar, code) => assert.throws(() => wrapJar(jar, cfg), e => e instanceof WrapError && e.code === code, code);

test('wraps a plain plugin: new main class extends the original, original untouched', () => {
  const { jar, main, package: pkg } = wrapJar(hello, cfg);
  assert.equal(main, 'com.acme.hello.HelloPlugin');
  assert.match(pkg, /^dev\.licensex\.w[0-9a-f]{8}$/);
  const names = listEntries(jar);
  for (const n of ['com/acme/hello/HelloPlugin.class', 'config.yml']) assert.ok(names.includes(n), n);
  assert.deepEqual(readEntry(jar, 'com/acme/hello/HelloPlugin.class'), readEntry(hello, 'com/acme/hello/HelloPlugin.class'));
  assert.ok(!names.some(n => n.endsWith('/Stub.class')), 'the placeholder superclass is not shipped');

  const yml = readEntry(jar, 'plugin.yml').toString();
  assert.match(yml, new RegExp(`^main: ${pkg.replace(/\./g, '\\.')}\\.Wrapper$`, 'm'));
  assert.match(yml, /^name: HelloPlugin$/m);                       // everything else preserved
  const w = readClass(readEntry(jar, pkg.replace(/\./g, '/') + '/Wrapper.class'));
  assert.equal(w.superName, 'com/acme/hello/HelloPlugin');         // Wrapper extends the real main class
  assert.equal(w.major, 52);                                       // Java 8 bytecode: loads on any server JVM
  assert.deepEqual(JSON.parse(readEntry(jar, 'licensex.json')), { ...cfg, main, wrapped: 1 });
});

test('no leftover references to the template package, and the class files parse', () => {
  const { jar, package: pkg } = wrapJar(hello, cfg);
  for (const n of listEntries(jar).filter(n => n.startsWith(pkg.replace(/\./g, '/') + '/'))) {
    const bytes = readEntry(jar, n);
    assert.ok(!bytes.includes('dev/licensex/wrap/'), n + ' still names the template package');
    readClass(bytes);
  }
});

test('two different plugins get different wrapper packages (Bukkit shares classes by name across plugins)', () => {
  const other = injectFiles(hello, [{ name: 'plugin.yml', content: 'name: Other\nversion: 1\nmain: com.acme.hello.HelloPlugin\n' }]);
  assert.notEqual(wrapJar(hello, cfg).package, wrapJar(other, { ...cfg, product: 'Other' }).package);
});

test('refuses jars it cannot protect, with a reason', () => {
  const yml = text => injectFiles(hello, [{ name: 'plugin.yml', content: text }]);
  fails(Buffer.from('nope'), 'NOT_A_JAR');
  fails(yml('name: X\nversion: 1\n'), 'NO_MAIN');
  fails(yml('name: X\nmain: com.acme.Missing\n'), 'MAIN_MISSING');
  fails(injectFiles(hello, [{ name: 'paper-plugin.yml', content: 'name: X' }]), 'PAPER_PLUGIN');
  fails(injectFiles(hello, [{ name: 'dev/licensex/client/LicenseClient.class', content: 'x' }]), 'ALREADY_INTEGRATED');
  fails(wrapJar(hello, cfg).jar, 'ALREADY_WRAPPED');
  const plain = injectFiles(hello, [{ name: 'readme.txt', content: 'x' }], { remove: n => n === 'plugin.yml' });
  fails(plain, 'NO_PLUGIN_YML');
});

test('final main class or final onEnable is refused', () => {
  // flip ACC_FINAL (0x0010) in the main class's access flags: use the class file's own parsed offset
  const cls = Buffer.from(readEntry(hello, 'com/acme/hello/HelloPlugin.class'));
  const probe = Buffer.from(cls);
  // access_flags sit right after the constant pool; locate by scanning for the known value 0x0021 (public super)
  let at = -1;
  for (let i = 10; i < cls.length - 2; i++) {
    probe.writeUInt16BE(0x0031, i);
    try { if (readClass(probe).access === 0x0031) { at = i; break; } } catch {}
    probe.writeUInt16BE(cls.readUInt16BE(i), i);
  }
  assert.ok(at > 0);
  const finalMain = injectFiles(hello, [{ name: 'com/acme/hello/HelloPlugin.class', content: probe }]);
  fails(finalMain, 'MAIN_FINAL');
});

test('signature files are removed (a modified signed jar would not load)', () => {
  const signed = injectFiles(hello, [{ name: 'META-INF/CERT.SF', content: 'x' }, { name: 'META-INF/CERT.RSA', content: 'x' }]);
  const names = listEntries(wrapJar(signed, cfg).jar);
  assert.ok(!names.some(n => /\.(SF|RSA)$/.test(n)));
});

test('BuiltByBit build keeps the placeholder in Gate, and a rewritten class still loads', () => {
  const { jar, package: pkg } = wrapJar(hello, { ...cfg, key: '' });
  const gateName = pkg.replace(/\./g, '/') + '/Gate.class';
  const gate = readEntry(jar, gateName);
  assert.ok(gate.includes('%%__BBB_LICENSE__%%'));
  const key = 'LX-ZZZZ-YYYY-XXXX-WWWW';
  const patched = mapUtf8(gate, s => s === '%%__BBB_LICENSE__%%' ? key : s);   // what BuiltByBit does per download
  assert.ok(patched.includes(key) && !patched.includes('%%__BBB_LICENSE__%%'));
  readClass(patched);
});

test('checkWrappable summary', () => {
  assert.deepEqual(checkWrappable(hello), { ok: true, main: 'com.acme.hello.HelloPlugin', code: '', message: '' });
  assert.equal(checkWrappable(Buffer.from('x')).ok, false);
});

test('hostile jars never crash the server: bombs, truncation, garbage inside', async () => {
  const { deflateRawSync } = await import('node:zlib');
  // a plugin.yml that inflates to far more than it claims
  const bomb = injectFiles(hello, [{ name: 'plugin.yml', content: 'main: x.Y\n' + 'a'.repeat(30 * 1024 * 1024) }]);
  const w = checkWrappable(bomb);
  assert.equal(w.ok, false); assert.equal(w.code, 'BAD_JAR');
  // truncated archives and random bytes
  for (const bad of [hello.subarray(0, hello.length - 40), hello.subarray(0, 100), Buffer.alloc(300, 7)]) {
    const r = checkWrappable(bad); assert.equal(r.ok, false);
  }
  // a class file that is garbage
  const junk = injectFiles(hello, [{ name: 'com/acme/hello/HelloPlugin.class', content: Buffer.from('not a class') }]);
  assert.equal(checkWrappable(junk).ok, false);
  void deflateRawSync;
});
