// Backup and restore, so moving LicenseX between (temporary) hosts never loses licenses.
// A backup is a zip: licensex.db (a consistent SQLite snapshot) + the uploaded plugin files.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { injectFiles, listEntries, readEntry } from './jarstamp.js';
import { migrate, reserveWorkspaceIds } from './db.js';

const EMPTY_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
// Parents before children, so foreign keys are satisfied; deleted in the opposite order.
// The first four hold the customers (workspaces), their plans and per-workspace settings; backups made before
// workspaces existed do not have them, and restoring such a backup leaves them alone.
const WORKSPACE_TABLES = ['workspaces', 'plans', 'ws_settings', 'stripe_events'];
const TABLES = ['workspaces', 'plans', 'settings', 'ws_settings', 'license_groups', 'licenses', 'servers', 'products', 'audit', 'stripe_events'];
const WORKSPACE_OWNED = ['license_groups', 'licenses', 'products', 'audit', 'ws_settings']; // rows that carry a workspace_id
const MAX_ENTRY = 256 * 1024 * 1024; // per file inside the backup (plugin jars can be tens of MB)
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

  // Read everything out of the zip BEFORE changing anything, so a damaged or oversized entry can't leave a half-restored server.
  let database; const pluginFiles = new Map();
  try {
    database = readEntry(zip, 'licensex.db', MAX_ENTRY);
    for (const n of names) {
      const m = /^products\/([a-z0-9-]{1,48}\.bin)$/.exec(n);
      if (m) pluginFiles.set(m[1], readEntry(zip, n, MAX_ENTRY));
    }
  } catch (e) { throw new RestoreError(`The backup is damaged or too large to read (${e.message}).`); }

  const snap = tmpPath('.db');
  writeFileSync(snap, database);
  try {
    const bak = new DatabaseSync(snap, { readOnly: true });
    const has = t => !!bak.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!has('licenses') || !has('settings')) throw new RestoreError('That database does not look like a LicenseX backup.');
    const inBackup = new Set(TABLES.filter(has));
    bak.close();
    // an old single-owner backup has no customers: keep the current ones (their data is replaced like everything else)
    const hasWorkspaces = inBackup.has('workspaces');
    const tables = TABLES.filter(t => hasWorkspaces || !WORKSPACE_TABLES.includes(t));

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`ATTACH DATABASE '${quote(snap)}' AS bak`);
    try {
      db.exec('BEGIN');
      for (const t of [...tables].reverse()) db.exec(`DELETE FROM main.${t}`);
      for (const t of tables) {
        if (!inBackup.has(t)) continue;
        const cols = c => db.prepare(`PRAGMA ${c}.table_info(${t})`).all().map(r => r.name);
        const bakCols = new Set(cols('bak'));
        const shared = cols('main').filter(c => bakCols.has(c)); // older backups may lack newer columns: defaults fill them
        if (shared.length) db.exec(`INSERT INTO main.${t} (${shared.join(',')}) SELECT ${shared.join(',')} FROM bak.${t}`);
      }
      if (hasWorkspaces) {
        // Every row must belong to a customer that exists, or the next person to sign up could be handed someone else's data.
        if (!db.prepare('SELECT 1 FROM main.workspaces WHERE id = 1').get()) throw new RestoreError('The backup has no owner workspace, so it cannot be restored.');
        for (const t of WORKSPACE_OWNED) {
          if (db.prepare(`SELECT 1 FROM main.${t} WHERE workspace_id NOT IN (SELECT id FROM main.workspaces) LIMIT 1`).get())
            throw new RestoreError(`The backup is inconsistent: some ${t.replace('_', ' ')} belong to a customer that is not in it.`);
        }
      }
      // keep the id counters at least as high as the backup's, so deleted ids are never handed out again
      const bakSeq = db.prepare("SELECT 1 FROM bak.sqlite_master WHERE name = 'sqlite_sequence'").get() ? db.prepare('SELECT name, seq FROM bak.sqlite_sequence').all() : [];
      for (const r of bakSeq) {
        if (!tables.includes(r.name)) continue;
        if (db.prepare('SELECT 1 FROM main.sqlite_sequence WHERE name = ?').get(r.name)) db.prepare('UPDATE main.sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(r.seq, r.name);
        else db.prepare('INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)').run(r.name, r.seq);
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    finally { db.exec('DETACH DATABASE bak'); db.exec('PRAGMA foreign_keys = ON'); }
  } finally { rmSync(snap, { force: true }); }

  // Bring an older backup's schema/seed data up to date, and make sure no new customer can ever reuse an id that data still points at.
  migrate(db);
  reserveWorkspaceIds(db);

  // Plugin files: only after the database restored fine.
  mkdirSync(productsDir, { recursive: true });
  for (const f of readdirSync(productsDir).filter(f => PRODUCT_FILE.test(f))) rmSync(join(productsDir, f), { force: true });
  for (const [name, data] of pluginFiles) writeFileSync(join(productsDir, name), data);
  // a product whose file was not in the backup must not claim to have one (its download would fail)
  for (const p of db.prepare('SELECT id, slug FROM products WHERE has_file = 1').all())
    if (!pluginFiles.has(p.slug + '.bin')) db.prepare('UPDATE products SET has_file = 0 WHERE id = ?').run(p.id);
  return { products: pluginFiles.size };
}
