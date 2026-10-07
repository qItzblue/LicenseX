import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch {
  console.error(`[LicenseX] This needs Node.js 22.13 or newer (this server runs ${process.version}). Pick a newer Node version in your host's settings, or install it from https://nodejs.org`);
  process.exit(1);
}

export { DatabaseSync };

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS license_groups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT 1,
      name        TEXT NOT NULL,
      max_servers INTEGER NOT NULL DEFAULT 1,   -- -1 = unlimited
      color       TEXT NOT NULL DEFAULT '#8b5cf6',
      created_at  INTEGER NOT NULL,
      UNIQUE (workspace_id, name)
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id  INTEGER NOT NULL DEFAULT 1,
      key           TEXT NOT NULL UNIQUE,
      owner         TEXT NOT NULL DEFAULT '',
      note          TEXT NOT NULL DEFAULT '',
      group_id      INTEGER REFERENCES license_groups(id) ON DELETE SET NULL,
      max_servers   INTEGER,                    -- NULL = inherit from group/default, -1 = unlimited
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
      block_reason  TEXT NOT NULL DEFAULT '',
      expires_at    INTEGER,
      source        TEXT NOT NULL DEFAULT 'admin',  -- admin | claim
      product       TEXT NOT NULL DEFAULT '',
      nonce         TEXT UNIQUE,                -- one license per download nonce
      issued_ip     TEXT NOT NULL DEFAULT '',
      issued_device TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS servers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id  INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      instance_id TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      ip          TEXT NOT NULL DEFAULT '',
      port        INTEGER,
      version     TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','removed')),
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      UNIQUE (license_id, instance_id)
    );

    CREATE TABLE IF NOT EXISTS products (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT 1,
      slug       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      filename   TEXT NOT NULL DEFAULT '',   -- original uploaded file name
      size       INTEGER NOT NULL DEFAULT 0,
      has_file   INTEGER NOT NULL DEFAULT 0,
      token      TEXT NOT NULL,              -- shared secret required on the download URL
      group_id   INTEGER REFERENCES license_groups(id) ON DELETE SET NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      downloads  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT 1,
      at     INTEGER NOT NULL,
      actor  TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT ''
    );
    -- A workspace is one customer's private account: its own products, licenses, groups and settings.
    -- Workspace 1 is the owner's ("house") workspace and is never limited by a plan.
    CREATE TABLE IF NOT EXISTS workspaces (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      name                   TEXT NOT NULL,
      owner_email            TEXT UNIQUE,
      owner_name             TEXT NOT NULL DEFAULT '',
      plan_key               TEXT NOT NULL DEFAULT 'free',
      plan_status            TEXT NOT NULL DEFAULT 'active' CHECK (plan_status IN ('active','past_due','canceled')),
      plan_until             INTEGER,                    -- end of the paid period; NULL = no end (free, lifetime, manual forever)
      plan_source            TEXT NOT NULL DEFAULT 'free' CHECK (plan_source IN ('free','manual','stripe')),
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT,
      suspended              INTEGER NOT NULL DEFAULT 0,
      suspended_reason       TEXT NOT NULL DEFAULT '',
      bbb_secret             TEXT UNIQUE,
      created_at             INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ws_settings (
      workspace_id INTEGER NOT NULL,
      key          TEXT NOT NULL,
      value        TEXT NOT NULL,
      PRIMARY KEY (workspace_id, key)
    );
    CREATE TABLE IF NOT EXISTS plans (
      key           TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      price_cents   INTEGER NOT NULL DEFAULT 0,
      currency      TEXT NOT NULL DEFAULT 'usd',
      interval      TEXT NOT NULL DEFAULT 'free' CHECK (interval IN ('free','month','year','once')),
      max_products  INTEGER NOT NULL DEFAULT 1,           -- -1 = unlimited
      max_licenses  INTEGER NOT NULL DEFAULT 25,          -- -1 = unlimited
      features      TEXT NOT NULL DEFAULT '',             -- one bullet per line
      highlight     INTEGER NOT NULL DEFAULT 0,
      active        INTEGER NOT NULL DEFAULT 1,
      sort          INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS stripe_events (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_servers_license ON servers(license_id);
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);
  `);
  migrate(db);
  return db;
}

const hasCol = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
const WS_SETTING_KEYS = ['default_limit', 'claims_enabled', 'public_removal', 'heartbeat_minutes', 'bbb_group_id'];

export const SEED_PLANS = [
  { key: 'free', name: 'Free', description: 'Try LicenseX with a small plugin.', price_cents: 0, interval: 'free', max_products: 1, max_licenses: 25, highlight: 0, sort: 0,
    features: '1 plugin\n25 licenses\nAutomatic license check, no code changes\nBuiltByBit integration\nBuyer license portal' },
  { key: 'pro', name: 'Pro', description: 'For developers selling plugins.', price_cents: 900, interval: 'month', max_products: 10, max_licenses: 2500, highlight: 1, sort: 1,
    features: '10 plugins\n2,500 licenses\nAutomatic license check, no code changes\nBuiltByBit integration\nGroups with server limits\nBuyer license portal' },
  { key: 'lifetime', name: 'Lifetime', description: 'Pay once, use it forever.', price_cents: 14900, interval: 'once', max_products: 25, max_licenses: 10000, highlight: 0, sort: 2,
    features: '25 plugins\n10,000 licenses\nEverything in Pro\nNo monthly fee, ever' },
];

/** Brings databases from older versions up to date. Safe to run on every start. */
function migrate(db) {
  // products: integration columns (added in v0.3)
  for (const [name, def] of [['wrap_ok', 'INTEGER NOT NULL DEFAULT 0'], ['wrap_code', "TEXT NOT NULL DEFAULT ''"],
                             ['wrap_message', "TEXT NOT NULL DEFAULT ''"], ['main_class', "TEXT NOT NULL DEFAULT ''"]])
    if (!hasCol(db, 'products', name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${def}`);

  // workspaces (v0.6): everything that already exists belongs to the owner's workspace 1
  for (const t of ['licenses', 'products', 'audit'])
    if (!hasCol(db, t, 'workspace_id')) db.exec(`ALTER TABLE ${t} ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1`);
  if (!hasCol(db, 'license_groups', 'workspace_id')) {
    // group names used to be globally unique; now unique per workspace, which SQLite can only do by rebuilding the table
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(`CREATE TABLE license_groups_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL,
        max_servers INTEGER NOT NULL DEFAULT 1, color TEXT NOT NULL DEFAULT '#8b5cf6', created_at INTEGER NOT NULL, UNIQUE (workspace_id, name))`);
      db.exec('INSERT INTO license_groups_new (id, workspace_id, name, max_servers, color, created_at) SELECT id, 1, name, max_servers, color, created_at FROM license_groups');
      db.exec('DROP TABLE license_groups');
      db.exec('ALTER TABLE license_groups_new RENAME TO license_groups');
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_licenses_ws ON licenses(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_products_ws ON products(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_groups_ws ON license_groups(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit(workspace_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_ws_stripe_cust ON workspaces(stripe_customer_id);
    CREATE INDEX IF NOT EXISTS idx_ws_stripe_sub ON workspaces(stripe_subscription_id);
  `);

  const now = Math.floor(Date.now() / 1000);
  if (!db.prepare('SELECT 1 FROM workspaces WHERE id = 1').get()) {
    const old = db.prepare("SELECT value FROM settings WHERE key = 'bbb_secret'").get();
    db.prepare("INSERT INTO workspaces (id, name, plan_key, plan_source, bbb_secret, created_at) VALUES (1, 'Owner', 'free', 'free', ?, ?)")
      .run(old?.value || Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(24))).toString('base64url'), now);
  }
  // the per-workspace settings used to be global: the existing values become workspace 1's
  if (!db.prepare('SELECT 1 FROM ws_settings WHERE workspace_id = 1 LIMIT 1').get())
    for (const k of WS_SETTING_KEYS) {
      const v = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      if (v) db.prepare('INSERT OR IGNORE INTO ws_settings (workspace_id, key, value) VALUES (1, ?, ?)').run(k, v.value);
    }
  if (!db.prepare('SELECT 1 FROM plans LIMIT 1').get())
    for (const p of SEED_PLANS)
      db.prepare('INSERT INTO plans (key, name, description, price_cents, interval, max_products, max_licenses, features, highlight, sort) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(p.key, p.name, p.description, p.price_cents, p.interval, p.max_products, p.max_licenses, p.features, p.highlight, p.sort);
}
