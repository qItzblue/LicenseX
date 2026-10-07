// Pure-Node ZIP/JAR editing: inject (or replace) files into an existing archive with no dependencies.
// A .jar is a .zip. We rewrite the central directory so an injected `licensex.json` is the authoritative
// entry, which lets LicenseX stamp a license key into a plugin jar at download time.
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50;
const DOS_TIME = 0, DOS_DATE = 0x5221; // fixed 2021-01-01 so output is reproducible

function findEocd(buf) {
  const min = Math.max(0, buf.length - (22 + 0xFFFF));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('Not a valid zip/jar (no end-of-central-directory record found)');
}

/** Names present in the archive's central directory. Used to detect replacements and for tests. */
export function listEntries(buf) {
  const eocd = findEocd(buf);
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const n = buf.readUInt16LE(p + 28), m = buf.readUInt16LE(p + 30), k = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + n));
    p += 46 + n + m + k;
  }
  return names;
}

/** Returns the (decompressed) bytes of one entry, or null if it isn't there. */
export function readEntry(buf, wanted) {
  const eocd = findEocd(buf);
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const n = buf.readUInt16LE(p + 28), m = buf.readUInt16LE(p + 30), k = buf.readUInt16LE(p + 32);
    if (buf.toString('utf8', p + 46, p + 46 + n) === wanted) {
      const lo = buf.readUInt32LE(p + 42);
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error('Unsupported compression method ' + method);
    }
    p += 46 + n + m + k;
  }
  return null;
}

/**
 * Return a new archive buffer with `files` ([{name, content}]) injected. If a name already exists its old
 * central-directory record is dropped (the central directory is authoritative, so the orphaned local bytes
 * are ignored by readers), guaranteeing the injected version wins.
 */
export function injectFiles(buf, files, { remove = () => false } = {}) {
  const eocd = findEocd(buf);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  if (centralOffset === 0xFFFFFFFF || totalEntries === 0xFFFF)
    throw new Error('ZIP64 archives are not supported');

  const inject = files.map(f => {
    const content = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content);
    return { name: Buffer.from(f.name, 'utf8'), nameStr: f.name, content, crc: crc32(content) };
  });
  const injectNames = new Set(inject.map(f => f.nameStr));

  // Keep original local records verbatim (offsets stay valid); append new local records after them.
  const localParts = [buf.subarray(0, centralOffset)];
  const centralParts = [];
  let offset = centralOffset, entries = 0;

  for (const f of inject) {
    const deflated = deflateRawSync(f.content, { level: 9 });
    const useDeflate = deflated.length < f.content.length;
    const method = useDeflate ? 8 : 0;
    const data = useDeflate ? deflated : f.content;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(f.crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(f.content.length, 22);
    local.writeUInt16LE(f.name.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, f.name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CEN_SIG, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(f.crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(f.content.length, 24);
    central.writeUInt16LE(f.name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, f.name);

    offset += 30 + f.name.length + data.length;
    entries++;
  }

  // Copy original central records, dropping any whose name we are replacing.
  let p = centralOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const n = buf.readUInt16LE(p + 28), m = buf.readUInt16LE(p + 30), k = buf.readUInt16LE(p + 32);
    const recLen = 46 + n + m + k;
    const name = buf.toString('utf8', p + 46, p + 46 + n);
    if (!injectNames.has(name) && !remove(name)) { centralParts.push(buf.subarray(p, p + recLen)); entries++; }
    p += recLen;
  }

  const newLocal = Buffer.concat(localParts);
  const newCentral = Buffer.concat(centralParts);
  const newEocd = Buffer.alloc(22);
  newEocd.writeUInt32LE(EOCD_SIG, 0); newEocd.writeUInt16LE(0, 4); newEocd.writeUInt16LE(0, 6);
  newEocd.writeUInt16LE(entries, 8); newEocd.writeUInt16LE(entries, 10);
  newEocd.writeUInt32LE(newCentral.length, 12); newEocd.writeUInt32LE(newLocal.length, 16); newEocd.writeUInt16LE(0, 20);
  return Buffer.concat([newLocal, newCentral, newEocd]);
}
