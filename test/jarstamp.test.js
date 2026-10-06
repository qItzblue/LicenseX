import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { injectFiles, listEntries } from '../server/jarstamp.js';

// A valid empty zip is just the 22-byte end-of-central-directory record.
const emptyZip = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);

/** Minimal reader: locate an entry via the central directory and decode it (stored or deflated). */
function read(buf, name) {
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const n = buf.readUInt16LE(p + 28), m = buf.readUInt16LE(p + 30), k = buf.readUInt16LE(p + 32);
    if (buf.toString('utf8', p + 46, p + 46 + n) === name) {
      const lo = buf.readUInt32LE(p + 42);
      const method = buf.readUInt16LE(lo + 8), csize = buf.readUInt32LE(lo + 18);
      const ln = buf.readUInt16LE(lo + 26), lm = buf.readUInt16LE(lo + 28);
      const data = buf.subarray(lo + 30 + ln + lm, lo + 30 + ln + lm + csize);
      return method === 8 ? inflateRawSync(data) : Buffer.from(data);
    }
    p += 46 + n + m + k;
  }
  return null;
}

test('inject into empty zip, round-trips both stored and deflated', () => {
  const small = Buffer.from('{"key":"LX-1234"}');
  const big = Buffer.from('ABCD'.repeat(4000)); // compressible -> deflate path
  const out = injectFiles(emptyZip(), [{ name: 'licensex.json', content: small }, { name: 'big.txt', content: big }]);
  assert.deepEqual(listEntries(out).sort(), ['big.txt', 'licensex.json']);
  assert.deepEqual(read(out, 'licensex.json'), small);
  assert.deepEqual(read(out, 'big.txt'), big);
  assert.ok(out.length < emptyZip().length + big.length); // big.txt really was compressed
});

test('replacing a name leaves exactly one central-directory entry, the new one', () => {
  let z = injectFiles(emptyZip(), [{ name: 'a.txt', content: 'original' }]);
  z = injectFiles(z, [{ name: 'a.txt', content: 'replaced' }]);
  assert.deepEqual(listEntries(z), ['a.txt']);
  assert.equal(read(z, 'a.txt').toString(), 'replaced');
});

test('rejects non-zip input', () => {
  assert.throws(() => injectFiles(Buffer.from('not a zip at all'), [{ name: 'x', content: 'y' }]), /valid zip/);
});
