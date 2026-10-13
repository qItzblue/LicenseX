// Minimal Java class-file reader/patcher (JVMS chapter 4). Enough to (a) read a plugin's main class and
// (b) rewrite names inside our precompiled wrapper classes. No dependencies.

const SIZES = { 3: 4, 4: 4, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4, 12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2 };

/** Walks the constant pool. Returns entries [{tag, start, end}] (1-based like the spec) and the offset after the pool. */
function parsePool(buf) {
  if (buf.length < 10 || buf.readUInt32BE(0) !== 0xCAFEBABE) throw new Error('Not a class file');
  const count = buf.readUInt16BE(8);
  const entries = new Array(count);
  let p = 10;
  for (let i = 1; i < count; i++) {
    const tag = buf[p];
    let len;
    if (tag === 1) len = 3 + buf.readUInt16BE(p + 1);
    else if (tag === 5 || tag === 6) len = 9;
    else if (SIZES[tag] !== undefined) len = 1 + SIZES[tag];
    else throw new Error('Unsupported constant pool tag ' + tag);
    entries[i] = { tag, start: p, end: p + len };
    if (tag === 5 || tag === 6) i++; // long/double take two slots
    p += len;
  }
  return { count, entries, end: p };
}

const isAscii = b => { for (const x of b) if (x === 0 || x > 0x7f) return false; return true; };

/** Rewrites every ASCII Utf8 constant through fn(string) -> string. Non-ASCII constants are left untouched. */
export function mapUtf8(buf, fn) {
  const { entries, end } = parsePool(buf);
  const out = [buf.subarray(0, 10)];
  let last = 10;
  for (const e of entries) {
    if (!e || e.tag !== 1) continue;
    const raw = buf.subarray(e.start + 3, e.end);
    if (!isAscii(raw)) continue;
    const s = raw.toString('latin1'), t = fn(s);
    if (t === s) continue;
    if (!isAscii(Buffer.from(t, 'utf8')) || Buffer.byteLength(t) > 0xFFFF) throw new Error('Cannot encode replacement');
    out.push(buf.subarray(last, e.start));
    const nb = Buffer.alloc(3 + t.length);
    nb[0] = 1; nb.writeUInt16BE(t.length, 1); nb.write(t, 3, 'latin1');
    out.push(nb);
    last = e.end;
  }
  out.push(buf.subarray(last));
  return Buffer.concat(out);
}

export const ACC = { PUBLIC: 0x0001, FINAL: 0x0010, INTERFACE: 0x0200, ABSTRACT: 0x0400 };

/** Reads the parts of a class that decide whether it can be subclassed by the wrapper. */
export function readClass(buf) {
  const pool = parsePool(buf);
  const utf8 = i => { const e = pool.entries[i]; if (!e || e.tag !== 1) return ''; return buf.toString('utf8', e.start + 3, e.end); };
  const className = i => { const e = pool.entries[i]; return e && e.tag === 7 ? utf8(buf.readUInt16BE(e.start + 1)) : ''; };
  let p = pool.end;
  const access = buf.readUInt16BE(p); p += 2;
  const name = className(buf.readUInt16BE(p)); p += 2;
  const superName = className(buf.readUInt16BE(p)); p += 2;
  p += 2 + 2 * buf.readUInt16BE(p); // interfaces
  const skipAttrs = () => { let n = buf.readUInt16BE(p); p += 2; while (n--) { p += 2; p += 4 + buf.readUInt32BE(p); } };
  let n = buf.readUInt16BE(p); p += 2;
  while (n--) { p += 6; skipAttrs(); } // fields
  const methods = [];
  n = buf.readUInt16BE(p); p += 2;
  while (n--) {
    const flags = buf.readUInt16BE(p), mname = utf8(buf.readUInt16BE(p + 2)), desc = utf8(buf.readUInt16BE(p + 4));
    p += 6; skipAttrs();
    methods.push({ name: mname, desc, flags });
  }
  return { access, name, superName, methods, major: buf.readUInt16BE(6) };
}
