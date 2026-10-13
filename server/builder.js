// "Upload the source, get a jar back": inspect an uploaded plugin source zip, build it with Maven or Gradle,
// and hand back the jar. Compiling code means running build tooling on this machine, so:
//  - nothing is executed until a person has seen the inspection report and pressed Build;
//  - anything that can run code at build time or looks dangerous at runtime must be explicitly trusted first;
//  - the build runs in its own temp folder with a minimal environment (none of LicenseX's secrets), under a time limit,
//    and one build at a time.
// This is a convenience for code YOU trust. It is not a sandbox: do not build strangers' code on a machine that
// also holds your licenses (see docs/BUILD.md).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, rmSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { extractZip, ZipError } from './zipx.js';
import { listEntries, readEntry } from './jarstamp.js';

export class BuildError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

const SKIP_DIRS = new Set(['node_modules', 'target', 'build', '.git', '.gradle', '.idea', 'out', '.settings']);
const MAX_SCAN_BYTES = 1024 * 1024;
const LOG_LIMIT = 300 * 1024;

// ---------------------------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------------------------
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p, base, out); }
    else out.push({ rel: relative(base, p).split(sep).join('/'), size: st.size });
  }
  return out;
}
const depth = rel => rel.split('/').length;
const read = (dir, rel) => { try { return readFileSync(join(dir, rel), 'utf8'); } catch { return ''; } };

function parseYamlTop(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
    if (m && m[2] !== '') out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const CODE_RULES = [
  { id: 'exec', sev: 'high', re: /\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\b|\bnew\s+ProcessBuilder\b/, title: 'Runs operating-system commands' },
  { id: 'classload', sev: 'high', re: /\bdefineClass\s*\(|\bnew\s+URLClassLoader\b|\bsun\.misc\.Unsafe\b|\bjdk\.internal\b/, title: 'Loads or defines classes at runtime' },
  { id: 'script', sev: 'high', re: /\bScriptEngineManager\b|\bjavax\.script\b/, title: 'Runs scripts' },
  { id: 'op', sev: 'high', re: /\.setOp\s*\(\s*true\s*\)|dispatchCommand\s*\([^)]*"\s*op\s/i, title: 'Grants operator permissions' },
  { id: 'exit', sev: 'high', re: /\bSystem\s*\.\s*exit\s*\(|\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*halt\b/, title: 'Can shut the whole JVM down' },
  { id: 'net', sev: 'medium', re: /\bnew\s+(Server)?Socket\s*\(|\.openConnection\s*\(|\bHttpClient\s*\.\s*new|\bHttpURLConnection\b/, title: 'Makes network connections' },
  { id: 'blob', sev: 'medium', re: /"[A-Za-z0-9+\/=]{500,}"/, title: 'Large encoded string (possible hidden payload)' },
  { id: 'reflect', sev: 'info', re: /\bsetAccessible\s*\(\s*true\s*\)|\bClass\s*\.\s*forName\s*\(\s*[^"'\s)]/, title: 'Uses reflection' },
  { id: 'env', sev: 'info', re: /\bSystem\s*\.\s*getenv\b/, title: 'Reads environment variables' },
];
const MAVEN_BUILD_RULES = [
  { id: 'mvn-exec', sev: 'high', re: /exec-maven-plugin|maven-antrun-plugin|gmaven|groovy-maven|maven-invoker|<executable>/i, title: 'Maven build runs commands or scripts' },
  { id: 'mvn-ext', sev: 'high', re: /<extensions>\s*true\s*<\/extensions>|<\/?extension>/i, title: 'Maven build loads extensions' },
  { id: 'mvn-system', sev: 'info', re: /<scope>\s*system\s*<\/scope>/i, title: 'Depends on jar files bundled in the project' },
];
const GRADLE_BUILD_RULES = [
  { id: 'gr-exec', sev: 'high', re: /\bexec\s*[({]|\bExec\b|\bcommandLine\b|\bRuntime\b|\bProcessBuilder\b|["']\s*\.execute\s*\(\s*\)|\.execute\(\)/, title: 'Gradle build runs commands' },
  { id: 'gr-apply', sev: 'high', re: /apply\s+from\s*:?\s*['"]https?:/, title: 'Gradle build loads a script from the internet' },
  { id: 'gr-buildscript', sev: 'medium', re: /\bbuildscript\s*\{/, title: 'Gradle build uses custom build-script dependencies' },
];
const NET_URL = /https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const KNOWN_HOSTS = /(^|\.)(papermc\.io|spigotmc\.org|bukkit\.org|maven\.org|apache\.org|github\.com|githubusercontent\.com|gradle\.org|jitpack\.io|sonatype\.org|sonatype\.com|w3\.org|oracle\.com|minecraft\.net|mojang\.com|adventure\.kyori\.net|kyori\.net|enginehub\.org|codemc\.io|extendedclip\.com|placeholderapi\.com|mvnrepository\.com|example\.com)$/i;

function scan(dir, files, report) {
  const add = f => { if (report.findings.length < 150) report.findings.push(f); };
  const hosts = new Set();
  for (const f of files) {
    if (f.size > MAX_SCAN_BYTES) continue;
    const isCode = /\.(java|kt|scala|groovy)$/.test(f.rel);
    const base = basename(f.rel);
    const isPom = base === 'pom.xml';
    const isGradle = /\.gradle(\.kts)?$/.test(base) || /^gradle[^/]*\.properties$/.test(base);
    if (!isCode && !isPom && !isGradle && base !== 'gradle-wrapper.properties') continue;
    const text = read(dir, f.rel);
    const lines = text.split(/\r?\n/);
    const rules = isCode ? CODE_RULES : isPom ? MAVEN_BUILD_RULES : GRADLE_BUILD_RULES;
    const area = isCode ? 'code' : 'build';
    for (const rule of rules) {
      for (let i = 0; i < lines.length; i++) {
        if (!rule.re.test(lines[i])) continue;
        add({ sev: rule.sev, id: rule.id, title: rule.title, area, file: f.rel, line: i + 1, snippet: lines[i].trim().slice(0, 160) });
        break; // one hit per rule per file is enough for a report
      }
    }
    if (base === 'gradle-wrapper.properties') {
      const m = /distributionUrl\s*=\s*(\S+)/.exec(text);
      if (m && !/^https:\\?\/\\?\/services\.gradle\.org\//.test(m[1])) add({ sev: 'high', id: 'gr-dist', title: 'Gradle wrapper downloads from an unusual address', area: 'build', file: f.rel, line: 1, snippet: m[1].slice(0, 160) });
    }
    if (isCode) for (const m of text.matchAll(NET_URL)) if (!KNOWN_HOSTS.test(m[1])) hosts.add(m[1].toLowerCase());
    if (isPom) for (const m of text.matchAll(/<url>\s*(https?:\/\/[^<\s]+)\s*<\/url>/gi)) {
      const h = new URL(m[1]).hostname;
      if (!KNOWN_HOSTS.test(h)) add({ sev: 'info', id: 'mvn-repo', title: 'Downloads dependencies from a custom repository', area: 'build', file: f.rel, line: 1, snippet: m[1] });
    }
  }
  report.network = [...hosts].sort().slice(0, 25);
}

/** Looks at an extracted source tree. Pure reading: no code is executed. */
export function inspectSource(dir) {
  const files = walk(dir);
  const report = { kind: 'none', root: '', plugin: null, mainFound: null, files: files.length, javaFiles: 0, lines: 0, java: '', deps: [], multiModule: false, wrapper: false, network: [], findings: [], warnings: [], needsTrust: false };

  const marks = files.filter(f => /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/.test(f.rel)).sort((a, b) => depth(a.rel) - depth(b.rel));
  if (marks.length) {
    const top = depth(marks[0].rel);
    const atTop = marks.filter(f => depth(f.rel) === top);
    const pom = atTop.find(f => f.rel.endsWith('pom.xml'));
    const chosen = pom || atTop[0];
    report.kind = chosen.rel.endsWith('pom.xml') ? 'maven' : 'gradle';
    report.root = chosen.rel.includes('/') ? chosen.rel.slice(0, chosen.rel.lastIndexOf('/')) : '';
  } else {
    report.warnings.push('No pom.xml or build.gradle was found, so LicenseX does not know how to build this. Upload a Maven or Gradle project.');
  }
  const under = rel => !report.root || rel.startsWith(report.root + '/');

  const ymls = files.filter(f => /(^|\/)plugin\.yml$/.test(f.rel) && under(f.rel)).sort((a, b) => (b.rel.includes('src/main/resources') - a.rel.includes('src/main/resources')) || depth(a.rel) - depth(b.rel));
  if (ymls.length) {
    const y = parseYamlTop(read(dir, ymls[0].rel));
    report.plugin = { file: ymls[0].rel, name: y.name || '', version: y.version || '', main: y.main || '', apiVersion: y['api-version'] || '', description: y.description || '', depend: y.depend || '', softdepend: y.softdepend || '' };
    if (report.plugin.main) {
      const want = report.plugin.main.replace(/\./g, '/');
      report.mainFound = files.some(f => f.rel.endsWith(`/${want}.java`) || f.rel.endsWith(`/${want}.kt`) || f.rel === `${want}.java`);
      if (!report.mainFound) report.warnings.push(`plugin.yml says main is ${report.plugin.main}, but no matching source file was found.`);
    } else report.warnings.push('plugin.yml has no "main:" line.');
    if (/\$\{|@.+@/.test(report.plugin.version)) report.warnings.push('The plugin version is filled in by the build (that is normal).');
  } else if (report.kind !== 'none') {
    report.warnings.push('No plugin.yml found. This builds, but the jar will not be a Bukkit/Spigot/Paper plugin.');
  }

  for (const f of files.filter(f => /\.(java|kt)$/.test(f.rel) && under(f.rel))) {
    report.javaFiles++;
    report.lines += (read(dir, f.rel).match(/\n/g) || []).length + 1;
  }

  if (report.kind === 'maven') {
    const pom = read(dir, (report.root ? report.root + '/' : '') + 'pom.xml');
    const rel = /<maven\.compiler\.release>\s*(\d+)|<release>\s*(\d+)\s*<\/release>|<java\.version>\s*(\d+)|<maven\.compiler\.(?:source|target)>\s*([\d.]+)/.exec(pom);
    report.java = rel ? (rel[1] || rel[2] || rel[3] || rel[4]) : '';
    report.multiModule = /<modules>/.test(pom);
    for (const d of ['paper-api', 'spigot-api', 'bukkit', 'folia-api', 'velocity-api', 'bungeecord-api']) if (pom.includes(d)) report.deps.push(d);
    if (/<module>/.test(pom) && report.multiModule) report.warnings.push('This is a multi-module project; the plugin jar is picked from all modules.');
  } else if (report.kind === 'gradle') {
    const g = files.filter(f => /(^|\/)build\.gradle(\.kts)?$/.test(f.rel) && under(f.rel)).map(f => read(dir, f.rel)).join('\n');
    const jv = /JavaLanguageVersion\.of\(\s*(\d+)|options\.release(?:\.set\()?\s*=?\s*(\d+)|sourceCompatibility\s*=?\s*(?:JavaVersion\.VERSION_)?['"]?([\d._]+)/.exec(g);
    report.java = jv ? (jv[1] || jv[2] || jv[3] || '').replace('_', '.') : '';
    for (const d of ['paper-api', 'spigot-api', 'bukkit', 'folia-api', 'velocity-api', 'bungeecord-api']) if (g.includes(d)) report.deps.push(d);
    report.wrapper = files.some(f => /(^|\/)gradlew$/.test(f.rel) && under(f.rel));
  }
  if (report.plugin && report.deps.some(d => /velocity|bungee/.test(d)) && !report.deps.some(d => /paper|spigot|bukkit|folia/.test(d))) report.warnings.push('This looks like a proxy plugin (Velocity/BungeeCord). LicenseX can build it, but the license wrapper only supports Bukkit/Spigot/Paper plugins.');

  scan(dir, files.filter(f => under(f.rel)), report);
  const order = { high: 0, medium: 1, info: 2 };
  report.findings.sort((a, b) => order[a.sev] - order[b.sev] || a.file.localeCompare(b.file));
  report.needsTrust = report.findings.some(f => f.sev === 'high');
  return report;
}

// ---------------------------------------------------------------------------------------------
// Tools and building
// ---------------------------------------------------------------------------------------------
const PASS_ENV = ['PATH', 'JAVA_HOME', 'JAVA_TOOL_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'LANG'];
function cleanEnv(extra = {}) {
  const env = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { LANG: 'C.UTF-8', ...env, ...extra };
}

let toolCache = { at: 0, value: null };
export function detectTools() {
  if (Date.now() - toolCache.at < 30000 && toolCache.value) return toolCache.value;
  const run = (cmd, args, pick) => {
    try {
      const r = spawnSync(cmd, args, { env: cleanEnv(), encoding: 'utf8', timeout: 8000 });
      if (r.error || r.status !== 0) return null;
      const out = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map(l => l.trim()).filter(l => l && !/^Picked up/.test(l));
      return pick(out);
    } catch { return null; }
  };
  const value = {
    java: run('javac', ['-version'], o => o[0] || 'javac'),
    maven: run('mvn', ['-v'], o => (o[0] || '').replace(/^Apache Maven\s*/, '').split(' ')[0] || 'mvn'),
    gradle: run('gradle', ['-v'], o => (o.find(l => /^Gradle /.test(l)) || 'Gradle').replace(/^Gradle\s*/, '')),
  };
  toolCache = { at: Date.now(), value };
  return value;
}

/** Finds the plugin jar a build produced. */
export function pickJar(rootAbs) {
  const jars = [];
  const visit = dir => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!['node_modules', '.git', '.gradle', 'src', '.m2'].includes(name)) visit(p); continue; }
      const inOut = /(^|[\\/])(target|build[\\/]libs)$/.test(dir);
      if (inOut && name.endsWith('.jar') && !/^original-|-sources\.jar$|-javadoc\.jar$|-plain\.jar$|-tests?\.jar$/.test(name)) jars.push({ path: p, size: st.size });
    }
  };
  visit(rootAbs);
  const scored = jars.map(j => {
    let hasPlugin = false, main = '';
    try { const y = readEntry(readFileSync(j.path), 'plugin.yml'); if (y) { hasPlugin = true; main = (/^main\s*:\s*(\S+)/m.exec(y.toString()) || [])[1] || ''; } } catch { /* not a readable jar */ }
    return { ...j, hasPlugin, main };
  });
  scored.sort((a, b) => (b.hasPlugin - a.hasPlugin) || (b.size - a.size));
  return scored[0] || null;
}

function runProcess(cmd, args, { cwd, env, onData, timeoutMs }) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let timedOut = false, done = false;
    const killTree = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const finish = (code, err) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, timedOut, err }); };
    child.on('error', e => finish(-1, e));
    child.on('close', code => finish(code));
  });
}

export function createBuildService({ baseDir, timeoutMs = 10 * 60 * 1000 }) {
  const jobsDir = join(baseDir, 'jobs');
  const cacheDir = join(baseDir, 'cache');
  const jobs = new Map();
  let running = null;

  mkdirSync(cacheDir, { recursive: true });
  rmSync(jobsDir, { recursive: true, force: true }); // jobs do not survive a restart
  mkdirSync(jobsDir, { recursive: true });

  const view = j => ({ id: j.id, status: j.status, filename: j.filename, createdAt: j.createdAt, report: j.report, trusted: j.trusted,
    log: j.log, error: j.error, jar: j.jar ? { name: j.jar.name, size: j.jar.size, plugin: j.jar.plugin } : null });
  const append = (j, text) => {
    j.log += text.split(j.src + '/').join('').split(j.src).join('<project>'); // do not show server paths

    if (j.log.length > LOG_LIMIT) j.log = '[...earlier output trimmed...]\n' + j.log.slice(-LOG_LIMIT * 0.8);
  };

  return {
    tools: detectTools,
    list: () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(view),
    get: id => { const j = jobs.get(id); return j ? view(j) : null; },

    /** Unpacks and inspects. Nothing is compiled or executed. */
    create(zipBuf, filename) {
      const id = randomBytes(6).toString('hex');
      const dir = join(jobsDir, id);
      const src = join(dir, 'src');
      try { extractZip(zipBuf, src); }
      catch (e) { rmSync(dir, { recursive: true, force: true }); throw new BuildError(e instanceof ZipError ? e.message : 'Could not read the zip.'); }
      const report = inspectSource(src);
      const job = { id, dir, src, status: 'inspected', filename: String(filename || 'source.zip').slice(0, 80), createdAt: Date.now(), report, trusted: false, log: '', error: '', jar: null };
      jobs.set(id, job);
      return view(job);
    },

    /** Starts the build in the background. */
    start(id, { trust = false } = {}) {
      const j = jobs.get(id);
      if (!j) throw new BuildError('Build not found.', 404);
      if (j.status === 'building') throw new BuildError('This build is already running.', 409);
      if (running) throw new BuildError('Another build is running. Wait for it to finish.', 409);
      if (j.report.kind === 'none') throw new BuildError('There is nothing to build: no pom.xml or build.gradle.');
      if (j.report.needsTrust && !trust) throw new BuildError('This project has high-risk findings. Read them and confirm you trust the code before building.', 400);
      const tools = detectTools();
      if (!tools.java) throw new BuildError('No Java compiler (JDK) is installed on this server, so it cannot build. See docs/BUILD.md.', 503);
      const wrapperOk = j.report.kind === 'gradle' && j.report.wrapper && trust;
      if (j.report.kind === 'maven' && !tools.maven) throw new BuildError('Maven is not installed on this server. See docs/BUILD.md.', 503);
      if (j.report.kind === 'gradle' && !tools.gradle && !wrapperOk) throw new BuildError('Gradle is not installed on this server (or the project\'s own wrapper needs you to trust the code). See docs/BUILD.md.', 503);

      j.trusted = !!trust; j.status = 'building'; j.log = ''; j.error = ''; j.jar = null;
      running = j.id;
      const root = join(j.src, j.report.root);
      const home = join(cacheDir, 'home');
      mkdirSync(home, { recursive: true });
      const m2 = join(process.env.LICENSEX_BUILD_M2 || join(cacheDir, 'm2'));
      let cmd, args, env;
      if (j.report.kind === 'maven') {
        cmd = 'mvn'; args = ['-B', '-ntp', '-Dmaven.test.skip=true', `-Dmaven.repo.local=${m2}`, 'package'];
        env = cleanEnv({ HOME: home, MAVEN_OPTS: '-Xmx512m' });
      } else if (wrapperOk) {
        cmd = 'sh'; args = ['./gradlew', 'build', '-x', 'test', '--no-daemon', '--console=plain'];
        env = cleanEnv({ HOME: home, GRADLE_USER_HOME: join(cacheDir, 'gradle'), GRADLE_OPTS: '-Xmx512m' });
      } else {
        cmd = 'gradle'; args = ['build', '-x', 'test', '--no-daemon', '--console=plain'];
        env = cleanEnv({ HOME: home, GRADLE_USER_HOME: join(cacheDir, 'gradle'), GRADLE_OPTS: '-Xmx512m' });
      }
      append(j, `$ ${cmd} ${args.join(' ')}\n`);

      runProcess(cmd, args, { cwd: root, env, timeoutMs, onData: d => append(j, d.toString()) }).then(r => {
        running = null;
        if (r.timedOut) { j.status = 'failed'; j.error = `The build took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped.`; return; }
        if (r.err) { j.status = 'failed'; j.error = `Could not start ${cmd}: ${r.err.message}`; return; }
        if (r.code !== 0) { j.status = 'failed'; j.error = `The build failed (exit code ${r.code}). See the log.`; return; }
        const picked = pickJar(root);
        if (!picked) { j.status = 'failed'; j.error = 'The build finished but produced no jar. Check that the project packages a jar.'; return; }
        const out = join(j.dir, 'out');
        mkdirSync(out, { recursive: true });
        const name = basename(picked.path);
        copyFileSync(picked.path, join(out, name));
        j.jar = { name, path: join(out, name), size: picked.size, plugin: picked.hasPlugin ? { main: picked.main } : null };
        j.status = 'done';
        if (!picked.hasPlugin) append(j, '\nNote: the jar has no plugin.yml, so it is not a Bukkit/Spigot/Paper plugin.\n');
      }).catch(e => { running = null; j.status = 'failed'; j.error = String(e.message || e); });
      return view(j);
    },

    jarFile(id) { const j = jobs.get(id); return j?.jar ? { path: j.jar.path, name: j.jar.name } : null; },
    remove(id) { const j = jobs.get(id); if (!j) return false; if (j.status === 'building') throw new BuildError('Wait for the build to finish.', 409); rmSync(j.dir, { recursive: true, force: true }); jobs.delete(id); return true; },
    /** Deletes finished jobs older than `maxAgeMs`. */
    sweep(maxAgeMs = 24 * 3600e3) { for (const j of [...jobs.values()]) if (j.status !== 'building' && Date.now() - j.createdAt > maxAgeMs) { rmSync(j.dir, { recursive: true, force: true }); jobs.delete(j.id); } },
  };
}
