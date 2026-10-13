// Turns any ordinary Bukkit/Spigot/Paper plugin jar into a license-gated one, with no changes to the plugin's source.
//
//   plugin.yml:  main: com.acme.Foo         ->   main: dev.licensex.w1a2b3c4d.Wrapper
//   Wrapper (precompiled) extends com.acme.Foo, so the original runs unchanged, but Wrapper.onEnable() first asks
//   the LicenseX server whether this license/server is allowed, and only then calls the original onEnable().
//
// The wrapper classes are precompiled (wrapper/build.sh -> server/wrapper/*.class). We only rewrite names inside
// them: Wrapper's superclass (a placeholder) becomes the plugin's real main class, and the package gets a
// per-plugin suffix, because Bukkit shares classes by name across plugins and two wrapped plugins must not
// accidentally share one Gate.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { injectFiles, listEntries, readEntry } from './jarstamp.js';
import { mapUtf8, readClass, ACC } from './classfile.js';

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'wrapper');
const STUB = 'dev/licensex/wrap/Stub';
const PKG = 'dev/licensex/wrap';

export class WrapError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let templates;
const loadTemplates = () => templates ??= readdirSync(TEMPLATE_DIR).filter(f => f.endsWith('.class') && f !== 'Stub.class')
  .map(f => ({ file: f, bytes: readFileSync(join(TEMPLATE_DIR, f)) }));

const MAIN_RE = /^(main\s*:\s*)(['"]?)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\2([ \t]*(?:#.*)?\r?)$/m;
const SIGNATURE_RE = /^META-INF\/[^/]+\.(SF|RSA|DSA|EC)$/i;

/**
 * Wraps `jar` (a Buffer). `config` is written to licensex.json: {url, key, product}. Leave key empty for builds
 * whose key is injected later (BuiltByBit placeholder). Throws WrapError when the jar can't be wrapped.
 */
export function wrapJar(jar, { url, key = '', product = '' }) {
  let names;
  try { names = listEntries(jar); } catch { throw new WrapError('NOT_A_JAR', 'That file is not a valid .jar archive.'); }
  const has = n => names.includes(n);

  if (has('paper-plugin.yml')) throw new WrapError('PAPER_PLUGIN', 'This plugin uses paper-plugin.yml, which LicenseX cannot wrap yet. Use a normal plugin.yml.');
  if (!has('plugin.yml')) throw new WrapError('NO_PLUGIN_YML', 'No plugin.yml found, so this is not a Bukkit/Spigot/Paper plugin.');
  if (has('dev/licensex/client/LicenseClient.class')) throw new WrapError('ALREADY_INTEGRATED', 'This plugin already contains the LicenseX client, so it is not wrapped.');

  let yml;
  try { yml = readEntry(jar, 'plugin.yml', 256 * 1024).toString('utf8').replace(/^\uFEFF/, ''); }
  catch { throw new WrapError('BAD_JAR', 'The plugin.yml inside this jar could not be read (corrupt or too large).'); }
  const m = MAIN_RE.exec(yml);
  if (!m) throw new WrapError('NO_MAIN', 'Could not find a "main:" line in plugin.yml.');
  const main = m[3];
  if (/^dev\.licensex\.w[0-9a-f]{8}\.Wrapper$/.test(main)) throw new WrapError('ALREADY_WRAPPED', 'This jar is already wrapped. Upload the original plugin jar instead.');

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

  const suffix = createHash('sha1').update(main + '\0' + product).digest('hex').slice(0, 8);
  const pkg = `dev/licensex/w${suffix}`;
  const rename = s => s.split(STUB).join(mainInternal).split(PKG).join(pkg);

  const files = loadTemplates().map(t => ({ name: `${pkg}/${t.file}`, content: mapUtf8(t.bytes, rename) }));
  files.push({ name: 'plugin.yml', content: yml.replace(MAIN_RE, `$1$2dev.licensex.w${suffix}.Wrapper$2$4`) });
  files.push({ name: 'licensex.json', content: JSON.stringify({ url, key, product, main, wrapped: 1 }) });
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
