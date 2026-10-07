// Backup and restore, so moving LicenseX between (temporary) hosts never loses licenses.
// A backup is a zip: licensex.db (a consistent SQLite snapshot) + the uploaded plugin files.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { injectFiles, listEntries, readEntry } from './jarstamp.js';

const EMPTY_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
// Parents before children, so foreign keys are satisfied; deleted in the opposite order.
const TABLES = ['settings', 'license_groups', 'licenses', 'servers', 'products', 'audit'];
const PRODUCT_FILE = /^[a-z0-9-]{1,48}\.bin$/;

const tmpPath = ext => join(tmpdir(), `licensex-${randomBytes(6).toString('hex')}${ext}`);
const quote = p => p.replace(/'/g, "''");

export function createBackup(db, productsDir) {
  const snap = tmpPath('.db');
  try {
    db.exec(`VACUUM INTO '${quote(snap)}'`);
    const files = [
      { name: 'backup.json', content: JSON.stringify({ app: 'licensex', version: 1, created: new Date().toISOString() }) },
      { name: 'licensex.db', content: readFileSync(snap) },
    ];
    for (const f of readdirSync(productsDir).filter(f => PRODUCT_FILE.test(f)))
      files.push({ name: `products/${f}`, content: readFileSync(join(productsDir, f)) });
    return injectFiles(EMPTY_ZIP, files);
  } finally { rmSync(snap, { force: true }); }
}

export class RestoreError extends Error {}

/** Replaces all data with the backup's. Throws RestoreError (and changes nothing) if the backup is unusable. */
export function restoreBackup(db, productsDir, zip, DatabaseSync) {
  let names;
  try { names = listEntries(zip); } catch { throw new RestoreError('That file is not a valid backup (not a zip).'); }
  if (!names.includes('licensex.db')) throw new RestoreError('That zip is not a LicenseX backup (licensex.db is missing).');

  const snap = tmpPath('.db');
  writeFileSync(snap, readEntry(zip, 'licensex.db'));
  try {
    const bak = new DatabaseSync(snap, { readOnly: true });
    const has = t => !!bak.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!has('licenses') || !has('settings')) throw new RestoreError('That database does not look like a LicenseX backup.');
    bak.close();

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`ATTACH DATABASE '${quote(snap)}' AS bak`);
    try {
      db.exec('BEGIN');
      for (const t of [...TABLES].reverse()) db.exec(`DELETE FROM main.${t}`);
      for (const t of TABLES) {
        const cols = c => db.prepare(`PRAGMA ${c}.table_info(${t})`).all().map(r => r.name);
        const bakCols = new Set(cols('bak'));
        const shared = cols('main').filter(c => bakCols.has(c)); // older backups may lack newer columns: defaults fill them
        if (shared.length) db.exec(`INSERT INTO main.${t} (${shared.join(',')}) SELECT ${shared.join(',')} FROM bak.${t}`);
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    finally { db.exec('DETACH DATABASE bak'); db.exec('PRAGMA foreign_keys = ON'); }
  } finally { rmSync(snap, { force: true }); }

  // Plugin files: only after the database restored fine.
  mkdirSync(productsDir, { recursive: true });
  for (const f of readdirSync(productsDir).filter(f => PRODUCT_FILE.test(f))) rmSync(join(productsDir, f), { force: true });
  let files = 0;
  for (const n of names) {
    const m = /^products\/([a-z0-9-]{1,48}\.bin)$/.exec(n);
    if (m) { writeFileSync(join(productsDir, m[1]), readEntry(zip, n)); files++; }
  }
  return { products: files };
}
