import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createCore, KEY_RE } from '../server/core.js';

const fresh = () => { const db = openDb(':memory:'); return { db, core: createCore(db) }; };
const reg = (core, key, id, ip = '1.2.3.4') => core.validate({ key, instanceId: id, name: id, port: 25565, version: '1', ip });

test('every claim nonce gets its own license, repeats are stable', () => {
  const { core } = fresh();
  const a = core.claim({ nonce: 'n1', ip: '9.9.9.9', device: 'd' });
  const a2 = core.claim({ nonce: 'n1', ip: '9.9.9.9', device: 'd' });
  const b = core.claim({ nonce: 'n2', ip: '9.9.9.9', device: 'd' }); // same IP + device, new download
  assert.match(a.key, KEY_RE);
  assert.equal(a.key, a2.key);
  assert.equal(a2.created, false);
  assert.notEqual(a.key, b.key);
});

test('server limit: license override > group > default', () => {
  const { db, core } = fresh();
  const lic = core.createLicense({});
  assert.equal(core.effectiveLimit(lic), 1);
  db.prepare("INSERT INTO license_groups(name,max_servers,created_at) VALUES('VIP',3,1)").run();
  db.prepare('UPDATE licenses SET group_id=1 WHERE id=?').run(lic.id);
  assert.equal(core.effectiveLimit(core.q.licenseById.get(lic.id)), 3);
  db.prepare('UPDATE licenses SET max_servers=5 WHERE id=?').run(lic.id);
  assert.equal(core.effectiveLimit(core.q.licenseById.get(lic.id)), 5);
});

test('limit enforced, heartbeat of known server is fine', () => {
  const { core } = fresh();
  const { key } = core.createLicense({});
  assert.ok(reg(core, key, 'a').ok);
  assert.ok(reg(core, key, 'a').ok);
  const r = reg(core, key, 'b');
  assert.equal(r.code, 'LIMIT_REACHED');
});

test('owner removal frees the slot and shuts the old instance down', () => {
  const { core } = fresh();
  const lic = core.createLicense({});
  reg(core, lic.key, 'a');
  const sid = core.q.serversOf.all(lic.id)[0].id;
  assert.ok(core.ownerRemove(lic, sid).ok);
  assert.ok(reg(core, lic.key, 'b').ok);                    // slot is free right away
  assert.equal(reg(core, lic.key, 'a').code, 'SERVER_REMOVED');
});

test('admin-disabled servers keep their slot and cannot be removed by the owner', () => {
  const { db, core } = fresh();
  const lic = core.createLicense({});
  reg(core, lic.key, 'a');
  const s = core.q.serversOf.all(lic.id)[0];
  db.prepare("UPDATE servers SET status='disabled' WHERE id=?").run(s.id);
  assert.equal(reg(core, lic.key, 'a').code, 'SERVER_DISABLED');
  assert.equal(core.ownerRemove(lic, s.id).code, 'SERVER_DISABLED');
  assert.equal(reg(core, lic.key, 'b').code, 'LIMIT_REACHED');
});

test('blocked and expired licenses are refused', () => {
  const { db, core } = fresh();
  const lic = core.createLicense({});
  db.prepare("UPDATE licenses SET status='blocked', block_reason='chargeback' WHERE id=?").run(lic.id);
  const r = reg(core, lic.key, 'a');
  assert.equal(r.code, 'LICENSE_BLOCKED');
  assert.equal(r.message, 'chargeback');
  db.prepare("UPDATE licenses SET status='active', expires_at=1 WHERE id=?").run(lic.id);
  assert.equal(reg(core, lic.key, 'a').code, 'LICENSE_EXPIRED');
});

test('unlimited (-1) and unknown keys', () => {
  const { core } = fresh();
  const lic = core.createLicense({ max_servers: -1 });
  for (const i of 'abcdef') assert.ok(reg(core, lic.key, i).ok);
  assert.equal(reg(core, 'LX-AAAA-AAAA-AAAA-AAAA', 'a').code, 'INVALID_KEY');
});
