import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      max_servers INTEGER NOT NULL DEFAULT 1,   -- -1 = unlimited
      color       TEXT NOT NULL DEFAULT '#8b5cf6',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
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

    CREATE TABLE IF NOT EXISTS audit (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      at     INTEGER NOT NULL,
      actor  TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_servers_license ON servers(license_id);
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);
  `);
  return db;
}
