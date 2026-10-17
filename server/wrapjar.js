// Turns any ordinary Bukkit/Spigot/Paper plugin jar into a license-gated one, with no changes to the plugin's source.
//
//   plugin.yml:  main: com.acme.Foo         ->   main: <random pkg>.<random Wrapper class>
//   The wrapper (precompiled) extends com.acme.Foo, so the original runs unchanged, but its onEnable() first asks
//   the LicenseX server whether this license/server is allowed, and only then calls the original onEnable().
//
// Hardening: the injected classes carry no obvious "licensex" names. Per plugin+product (seeded from a server
// secret) we rewrite the package, every injected class name, the runtime marker filenames, and the config
// resource to unguessable random identifiers, so the check cannot be found by grepping for "licensex", and the
// embedded {url, key, product, main} config is XOR-masked and base64'd under a random filename instead of a
// plaintext licensex.json. None of this stops someone with the source, but it makes a wrapped jar much harder to
// strip by hand. The wrapper classes are precompiled (wrapper/build.sh -> server/wrapper/*.class); here we only
// rewrite constant-pool strings and file names inside them.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { injectFiles, listEntries, readEntry } from './jarstamp.js';
import { mapUtf8, readClass, ACC } from './classfile.js';

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'wrapper');
const PKG = 'dev/licensex/wrap';            // the package the templates are compiled in
const SEAL = 'META-INF/.sealed';            // marker: a jar we have already wrapped (double-wrap guard)

export class WrapError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let templates;
const loadTemplates = () => templates ??= readdirSync(TEMPLATE_DIR).filter(f => f.endsWith('.class') && f !== 'Stub.class')
  .map(f => ({ file: f, bytes: readFileSync(join(TEMPLATE_DIR, f)) }));

const MAIN_RE = /^(main\s*:\s*)(['"]?)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\2([ \t]*(?:#.*)?\r?)$/m;
const SIGNATURE_RE = /^META-INF\/[^/]+\.(SF|RSA|DSA|EC)$/i;

// A deterministic byte stream from a seed, so the same plugin+product always wraps to the same names.
function prng(seed) {
  let pool = Buffer.alloc(0), ctr = 0;
  return n => {
    while (pool.length < n) { pool = Buffer.concat([pool, createHash('sha256').update(seed).update(Buffer.from([ctr & 0xff, ctr >> 8])).digest()]); ctr++; }
    const r = pool.subarray(0, n); pool = pool.subarray(n); return r;
  };
}
const LET = 'abcdefghijklmnopqrstuvwxyz', ALNUM = LET + '0123456789';
const ident = (rnd, len) => { const b = rnd(len); let s = LET[b[0] % 26]; for (let i = 1; i < len; i++) s += ALNUM[b[i] % 36]; return s; };
const configMask = secret => createHash('sha256').update('licensex-wrap-config\0').update(String(secret)).digest().subarray(0, 16);
const xor = (buf, mask) => { const o = Buffer.alloc(buf.length); for (let i = 0; i < buf.length; i++) o[i] = buf[i] ^ mask[i % mask.length]; return o; };

/**
 * Reads the embedded config ({url, key, product, main, mark, ...}) back out of a jar this server wrapped, or the
 * plaintext licensex.json of an already-integrated plugin. Used by the leak tracer. Returns the object or null.
 */
export function readWrappedConfig(jar, secret = '') {
  try {
    const plain = readEntry(jar, 'licensex.json', 64 * 1024);
    if (plain) { const c = JSON.parse(plain.toString('utf8')); if (c && typeof c === 'object') return c; }
  } catch { /* not that kind of jar */ }
  let names;
  try { names = listEntries(jar); } catch { return null; }
  const mask = configMask(secret);
  for (const n of names) {
    if (n.includes('/') || /\.(class|yml|yaml|json|png|properties)$/i.test(n)) continue;
    let raw;
    try { raw = readEntry(jar, n, 64 * 1024); } catch { continue; }
    if (!raw || raw.length < 8 || raw.length > 48 * 1024) continue;
    let data;
    try { data = Buffer.from(raw.toString('latin1').trim(), 'base64'); } catch { continue; }
    if (!data.length) continue;
    try { const c = JSON.parse(xor(data, mask).toString('utf8')); if (c && c.wrapped === 1 && typeof c.url === 'string') return c; } catch { /* not the config */ }
  }
  return null;
}

/**
 * Wraps `jar` (a Buffer). The embedded config {url, key, product, main} is masked into a random resource. Leave
 * key empty for builds whose key is injected later (BuiltByBit placeholder). `secret` makes the generated names
 * unguessable. Throws WrapError when the jar can't be wrapped.
 */
export function wrapJar(jar, { url, key = '', product = '', mark = '', secret = '', pub = '' }) {
  let names;
  try { names = listEntries(jar); } catch { throw new WrapError('NOT_A_JAR', 'That file is not a valid .jar archive.'); }
  const has = n => names.includes(n);

  if (has('paper-plugin.yml')) throw new WrapError('PAPER_PLUGIN', 'This plugin uses paper-plugin.yml, which LicenseX cannot wrap yet. Use a normal plugin.yml.');
  if (!has('plugin.yml')) throw new WrapError('NO_PLUGIN_YML', 'No plugin.yml found, so this is not a Bukkit/Spigot/Paper plugin.');
  if (has('dev/licensex/client/LicenseClient.class')) throw new WrapError('ALREADY_INTEGRATED', 'This plugin already contains the LicenseX client, so it is not wrapped.');
  if (has(SEAL)) throw new WrapError('ALREADY_WRAPPED', 'This jar is already wrapped. Upload the original plugin jar instead.');

  let yml;
  try { yml = readEntry(jar, 'plugin.yml', 256 * 1024).toString('utf8').replace(/^\uFEFF/, ''); }
  catch { throw new WrapError('BAD_JAR', 'The plugin.yml inside this jar could not be read (corrupt or too large).'); }
  const m = MAIN_RE.exec(yml);
  if (!m) throw new WrapError('NO_MAIN', 'Could not find a "main:" line in plugin.yml.');
  const main = m[3];

  const mainInternal = main.replace(/\./g, '/');
  let mainBytes;
  try { mainBytes = readEntry(jar, mainInternal + '.class'); }
  catch { throw new WrapError('BAD_JAR', `The main class ${main} could not be read (corrupt or too large).`); }
  if (!mainBytes) throw new WrapError('MAIN_MISSING', `The main class ${main} is not inside this jar.`);
  let info;
  try { info = readClass(mainBytes); } catch { throw new WrapError('BAD_CLASS', `Could not read ${main}.`); }
  if (info.access & ACC.FINAL) throw new WrapError('MAIN_FINAL', `The main class ${main} is declared final, so it cannot be wrapped. Remove "final" and rebuild.`);
  if (info.access & (ACC.INTERFACE | ACC.ABSTRACT)) throw new WrapError('MAIN_ABSTRACT', `The main class ${main} is abstract.`);
  for (const meth of info.methods)
    if ((meth.name === 'onEnable' || meth.name === 'onDisable') && meth.desc === '()V' && (meth.flags & ACC.FINAL))
      throw new WrapError('METHOD_FINAL', `${main}.${meth.name}() is final, so it cannot be wrapped. Remove "final" and rebuild.`);

  // Everything below is derived from the seed, so it is stable per plugin+product but unguessable without the secret.
  const rnd = prng(createHash('sha256').update(String(secret)).update('\0').update(main).update('\0').update(product).digest());
  const pkg = `${ident(rnd, 6)}/${ident(rnd, 6)}`;
  const cls = {};
  for (const base of ['Gate', 'Beat', 'Disable', 'Wrapper']) { let n; do { n = ident(rnd, 6); } while (Object.values(cls).includes(n)); cls[base] = n; }
  const cfgName = ident(rnd, 8) + '.' + ['dat', 'bin', 'cache', 'idx'][rnd(1)[0] % 4];
  const instName = '.' + ident(rnd, 8), okName = '.' + ident(rnd, 8);
  // The config mask is derived from the server secret (not the per-product seed) so the leak tracer can read the
  // config back out of any jar this server made, while url/key/product stay out of plain sight.
  const mask = configMask(secret), maskB64 = mask.toString('base64');
  const sigKey = Buffer.from(rnd(16)), sigB64 = sigKey.toString('base64');   // signs the offline-grace file so it can't be hand-edited

  // Ordered so the per-class names (which contain the template package) are replaced before the bare package.
  const reps = [
    [`${PKG}/Stub`, mainInternal],
    [`${PKG}/Gate`, `${pkg}/${cls.Gate}`], [`${PKG}/Beat`, `${pkg}/${cls.Beat}`],
    [`${PKG}/Disable`, `${pkg}/${cls.Disable}`], [`${PKG}/Wrapper`, `${pkg}/${cls.Wrapper}`],
    [PKG, pkg],
    ['__LX_CFG__', cfgName], ['__LX_MASK__', maskB64], ['__LX_INST__', instName], ['__LX_OK__', okName], ['__LX_SIG__', sigB64],
  ];
  const rename = s => reps.reduce((acc, [a, b]) => acc.split(a).join(b), s);
  // Gate.class, Gate$Result.class, Beat.class, Disable.class, Wrapper.class -> their randomized names.
  const fileFor = f => { const mm = /^([A-Za-z]+)(\$[A-Za-z0-9]+)?\.class$/.exec(f); return `${pkg}/${cls[mm[1]]}${mm[2] || ''}.class`; };

  const confJson = Buffer.from(JSON.stringify({ url, key, product, main, wrapped: 1, ...(mark ? { mark } : {}), ...(pub ? { pub } : {}) }), 'utf8');
  const masked = Buffer.alloc(confJson.length);
  for (let i = 0; i < confJson.length; i++) masked[i] = confJson[i] ^ mask[i % mask.length];

  const files = loadTemplates().map(t => ({ name: fileFor(t.file), content: mapUtf8(t.bytes, rename) }));
  files.push({ name: 'plugin.yml', content: yml.replace(MAIN_RE, `$1$2${pkg.replace(/\//g, '.')}.${cls.Wrapper}$2$4`) });
  files.push({ name: cfgName, content: Buffer.from(masked.toString('base64'), 'latin1') });
  files.push({ name: SEAL, content: Buffer.alloc(0) });
  let out;
  try { out = injectFiles(jar, files, { remove: n => SIGNATURE_RE.test(n) }); }
  catch (e) { throw new WrapError('BAD_JAR', `This jar could not be processed (${e.message}).`); }
  return { jar: out, main, package: pkg.replace(/\//g, '.') };
}

/** Dry run used at upload time to tell the admin whether auto-integration will work. */
export function checkWrappable(jar) {
  try { const r = wrapJar(jar, { url: 'https://example.invalid', product: 'check' }); return { ok: true, main: r.main, code: '', message: '' }; }
  catch (e) {
    if (e instanceof WrapError) return { ok: false, code: e.code, message: e.message, integrated: e.code === 'ALREADY_INTEGRATED' };
    return { ok: false, code: 'BAD_JAR', message: 'This file could not be analysed.', integrated: false };
  }
}
