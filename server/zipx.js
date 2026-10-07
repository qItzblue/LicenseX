// Safe extraction of untrusted zip files (uploaded plugin source). Rejects zip-slip paths, symlinks, encrypted
// entries, absurd sizes and file counts, and bounds decompression so a zip bomb cannot exhaust memory or disk.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, sep, posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { readCentral } from './jarstamp.js';

export class ZipError extends Error {}

const DEFAULTS = { maxFiles: 5000, maxTotalBytes: 200 * 1024 * 1024, maxFileBytes: 50 * 1024 * 1024 };

/** Normalises an entry name to a relative posix path, or throws. */
export function safeName(name) {
  if (name.includes('\0') || name.includes('\\')) throw new ZipError(`Unsafe file name in zip: ${JSON.stringify(name)}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ZipError(`Absolute path in zip: ${name}`);
  const clean = posix.normalize(name);
  if (clean === '..' || clean.startsWith('../') || clean.split('/').includes('..')) throw new ZipError(`Path escapes the folder: ${name}`);
  return clean.replace(/^\.\//, '');
}

/** Lists what extractZip would write, after validation. Nothing touches the disk. */
export function planZip(buf, limits = {}) {
  const L = { ...DEFAULTS, ...limits };
  let entries;
  try { entries = readCentral(buf); } catch (e) { throw new ZipError(e.message.includes('Not a valid') ? 'That file is not a valid zip.' : e.message); }
  const files = [];
  let total = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;                                  // directories are created implicitly
    if (e.flags & 1) throw new ZipError('The zip contains encrypted files.');
    const type = e.mode & 0o170000;
    if (e.madeBy >> 8 === 3 && type === 0o120000) throw new ZipError(`The zip contains a symbolic link (${e.name}), which is not allowed.`);
    if (e.method !== 0 && e.method !== 8) throw new ZipError(`Unsupported compression in ${e.name}.`);
    if (e.usize > L.maxFileBytes) throw new ZipError(`${e.name} is too large (limit ${L.maxFileBytes >> 20} MB per file).`);
    total += e.usize;
    if (total > L.maxTotalBytes) throw new ZipError(`The zip expands to more than ${L.maxTotalBytes >> 20} MB.`);
    files.push({ ...e, path: safeName(e.name) });
    if (files.length > L.maxFiles) throw new ZipError(`The zip has more than ${L.maxFiles} files.`);
  }
  if (!files.length) throw new ZipError('The zip is empty.');
  return files;
}

/** Extracts into `dest` (must be an empty, private directory). Returns the relative file paths written. */
export function extractZip(buf, dest, limits = {}) {
  const L = { ...DEFAULTS, ...limits };
  const files = planZip(buf, L);
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  for (const f of files) {
    const target = resolve(root, f.path);
    if (target !== root && !target.startsWith(root + sep)) throw new ZipError(`Path escapes the folder: ${f.name}`);
    const start = f.offset + 30 + buf.readUInt16LE(f.offset + 26) + buf.readUInt16LE(f.offset + 28);
    const raw = buf.subarray(start, start + f.csize);
    let data;
    // Never trust the declared size: cap the real output.
    try { data = f.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.min(L.maxFileBytes, f.usize + 1) }); }
    catch { throw new ZipError(`Could not unpack ${f.name} (corrupt or larger than declared).`); }
    if (data.length !== f.usize) throw new ZipError(`${f.name} does not match its declared size.`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return files.map(f => f.path);
}
