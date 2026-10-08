// Team page API: design roles (sets of permissions) and give people access with them, optionally limited to some products.
// Everything is scoped to ctx.wsId. The caller needs the team.manage permission (which a product-limited member never has).
//
// Rules that keep this from becoming a way to escalate:
//   - you can only hand out permissions you hold yourself, and only touch roles/members that do not exceed your own access;
//   - nobody can change their own membership;
//   - the owner of the workspace is not a member row and cannot be touched here at all.
import { PERMISSIONS, TEMPLATES, cleanPermissions, RoleError, normEmail, validEmail } from './rbac.js';

const MAX_ROLES = 20, MAX_MEMBERS = 50;

export function registerTeam(app) {
  const { route, db, core, HttpError, body, int, str, now, HOUSE } = app;
  const perm = { perm: 'team.manage' };
  const house = ctx => ctx.wsId === HOUSE;
  const audit = (ctx, action, target, detail = '') => core.log(ctx.admin?.email || 'admin', action, target, detail, ctx.wsId);
  const parsePerms = json => { try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; } };
  /** May the caller hand out / modify something that carries exactly these permissions? */
  const covers = (ctx, perms) => ctx.access.owner || perms.every(k => ctx.access.perms.has(k));
  const roleOf = (ctx, id) => {
    const r = db.prepare('SELECT * FROM roles WHERE id = ? AND workspace_id = ?').get(id, ctx.wsId);
    if (!r) throw new HttpError(404, 'Not found');
    return { ...r, permissions: parsePerms(r.permissions) };
  };
  const memberOf = (ctx, id) => {
    const m = db.prepare('SELECT m.*, r.permissions role_permissions FROM members m JOIN roles r ON r.id = m.role_id WHERE m.id = ? AND m.workspace_id = ?').get(id, ctx.wsId);
    if (!m) throw new HttpError(404, 'Not found');
    return m;
  };
  const productIds = (ctx, v) => {
    if (!Array.isArray(v)) throw new HttpError(400, 'Pick the products this person may work with.');
    const ids = [...new Set(v.map(x => int(x, { min: 1 })))];
    if (!ids.length) throw new HttpError(400, 'Pick at least one product, or give access to all products.');
    const own = new Set(db.prepare('SELECT id FROM products WHERE workspace_id = ?').all(ctx.wsId).map(r => r.id));
    if (ids.some(i => !own.has(i))) throw new HttpError(400, 'Unknown product.');
    return ids;
  };
  const cleanName = (v, label, max = 40) => {
    const n = str(v, max).trim();
    if (!n) throw new HttpError(400, `${label} required`);
    return n;
  };
  const cleanRolePermissions = (ctx, list) => {
    let perms;
    try { perms = cleanPermissions(list, { house: house(ctx) }); } catch (e) { if (e instanceof RoleError) throw new HttpError(400, e.message); throw e; }
    if (!covers(ctx, perms)) throw new HttpError(403, 'You can only give out permissions that you have yourself.', 'FORBIDDEN');
    return perms;
  };

  /** Workspaces get a few ready-made roles the first time they open the Team page (they can change or delete them). */
  function seedRoles(wsId) {
    if (db.prepare("SELECT 1 FROM ws_settings WHERE workspace_id = ? AND key = 'roles_seeded'").get(wsId)) return;
    db.exec('BEGIN');
    try {
      if (!db.prepare('SELECT 1 FROM roles WHERE workspace_id = ? LIMIT 1').get(wsId))
        for (const t of TEMPLATES) db.prepare('INSERT INTO roles (workspace_id, name, description, permissions, created_at) VALUES (?,?,?,?,?)').run(wsId, t.name, t.description, JSON.stringify(cleanPermissions(t.permissions)), now());
      db.prepare("INSERT OR REPLACE INTO ws_settings (workspace_id, key, value) VALUES (?, 'roles_seeded', '1')").run(wsId);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  route('GET', '/api/admin/team', async ctx => {
    seedRoles(ctx.wsId);
    const roles = db.prepare('SELECT r.*, (SELECT COUNT(*) FROM members m WHERE m.role_id = r.id) members FROM roles r WHERE r.workspace_id = ? ORDER BY r.id').all(ctx.wsId)
      .map(r => ({ id: r.id, name: r.name, description: r.description, permissions: parsePerms(r.permissions), members: r.members, editable: covers(ctx, parsePerms(r.permissions)) }));
    const links = new Map();
    for (const l of db.prepare('SELECT mp.member_id, mp.product_id FROM member_products mp JOIN members m ON m.id = mp.member_id WHERE m.workspace_id = ?').all(ctx.wsId))
      links.set(l.member_id, [...(links.get(l.member_id) || []), l.product_id]);
    const members = db.prepare('SELECT m.*, r.name role_name, r.permissions role_permissions FROM members m JOIN roles r ON r.id = m.role_id WHERE m.workspace_id = ? ORDER BY m.id').all(ctx.wsId)
      .map(m => ({ id: m.id, email: m.email, name: m.name, role_id: m.role_id, role_name: m.role_name, all_products: !!m.all_products, product_ids: links.get(m.id) || [],
        disabled: !!m.disabled, invited_by: m.invited_by, last_login: m.last_login, created_at: m.created_at, editable: covers(ctx, parsePerms(m.role_permissions)) && m.id !== ctx.admin.member?.id }));
    const owner = db.prepare('SELECT owner_email, owner_name FROM workspaces WHERE id = ?').get(ctx.wsId);
    return [200, {
      permissions: PERMISSIONS.filter(p => !p.house || house(ctx)).map(({ key, group, label, scoped }) => ({ key, group, label, scoped, held: ctx.access.owner || ctx.access.perms.has(key) })),
      roles, members, owner: owner?.owner_email ? { email: owner.owner_email, name: owner.owner_name } : null,
      products: db.prepare('SELECT id, name FROM products WHERE workspace_id = ? ORDER BY name').all(ctx.wsId),
      limits: { roles: MAX_ROLES, members: MAX_MEMBERS }, you: { owner: ctx.access.owner, member_id: ctx.admin.member?.id ?? null },
    }];
  }, perm);

  // ---- roles -------------------------------------------------------------------------------------------------
  route('POST', '/api/admin/team/roles', async ctx => {
    const b = await body(ctx.req);
    const name = cleanName(b.name, 'Name'), permissions = cleanRolePermissions(ctx, b.permissions);
    if (db.prepare('SELECT COUNT(*) n FROM roles WHERE workspace_id = ?').get(ctx.wsId).n >= MAX_ROLES) throw new HttpError(409, `At most ${MAX_ROLES} roles.`);
    let id;
    try { id = Number(db.prepare('INSERT INTO roles (workspace_id, name, description, permissions, created_at) VALUES (?,?,?,?,?)').run(ctx.wsId, name, str(b.description, 140).trim(), JSON.stringify(permissions), now()).lastInsertRowid); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A role with that name exists.'); throw e; }
    audit(ctx, 'role.create', name, permissions.join(','));
    return [201, { ok: true, id }];
  }, perm);
  route('PATCH', '/api/admin/team/roles/:id', async ctx => {
    const role = roleOf(ctx, ctx.params.id), b = await body(ctx.req);
    if (!covers(ctx, role.permissions)) throw new HttpError(403, 'This role has more access than you do, so you cannot change it.', 'FORBIDDEN');
    const name = 'name' in b ? cleanName(b.name, 'Name') : role.name;
    const description = 'description' in b ? str(b.description, 140).trim() : role.description;
    const permissions = 'permissions' in b ? cleanRolePermissions(ctx, b.permissions) : role.permissions;
    try { db.prepare('UPDATE roles SET name = ?, description = ?, permissions = ? WHERE id = ?').run(name, description, JSON.stringify(permissions), role.id); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A role with that name exists.'); throw e; }
    audit(ctx, 'role.update', name, permissions.join(','));
    return [200, { ok: true }];
  }, perm);
  route('DELETE', '/api/admin/team/roles/:id', async ctx => {
    const role = roleOf(ctx, ctx.params.id);
    if (!covers(ctx, role.permissions)) throw new HttpError(403, 'This role has more access than you do, so you cannot delete it.', 'FORBIDDEN');
    if (db.prepare('SELECT 1 FROM members WHERE role_id = ?').get(role.id)) throw new HttpError(409, 'People still have this role. Give them another role first.');
    db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
    audit(ctx, 'role.delete', role.name);
    return [200, { ok: true }];
  }, perm);

  // ---- members -----------------------------------------------------------------------------------------------
  const setScope = (memberId, ids) => {
    db.prepare('DELETE FROM member_products WHERE member_id = ?').run(memberId);
    for (const id of ids) db.prepare('INSERT INTO member_products (member_id, product_id) VALUES (?, ?)').run(memberId, id);
  };
  route('POST', '/api/admin/team/members', async ctx => {
    const b = await body(ctx.req);
    const email = normEmail(b.email);
    if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
    const role = roleOf(ctx, int(b.role_id, { min: 1 }));
    if (!covers(ctx, role.permissions)) throw new HttpError(403, 'That role has more access than you do, so you cannot give it to someone.', 'FORBIDDEN');
    const all = b.all_products !== false, ids = all ? [] : productIds(ctx, b.product_ids);
    if (db.prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_email = ?').get(ctx.wsId, email)) throw new HttpError(409, 'That is the owner of this workspace; they already have full access.');
    if (db.prepare('SELECT COUNT(*) n FROM members WHERE workspace_id = ?').get(ctx.wsId).n >= MAX_MEMBERS) throw new HttpError(409, `At most ${MAX_MEMBERS} team members.`);
    let id;
    db.exec('BEGIN');
    try {
      id = Number(db.prepare('INSERT INTO members (workspace_id, email, name, role_id, all_products, invited_by, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(ctx.wsId, email, str(b.name, 80).trim(), role.id, all ? 1 : 0, ctx.admin?.email || '', now()).lastInsertRowid);
      setScope(id, ids);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That person is already on the team.');
      throw e;
    }
    audit(ctx, 'member.add', email, `${role.name}${all ? '' : ` (limited to ${ids.length} product${ids.length === 1 ? '' : 's'})`}`);
    return [201, { ok: true, id }];
  }, perm);
  route('PATCH', '/api/admin/team/members/:id', async ctx => {
    const m = memberOf(ctx, ctx.params.id), b = await body(ctx.req);
    if (m.id === ctx.admin.member?.id) throw new HttpError(403, 'You cannot change your own access.', 'FORBIDDEN');
    if (!covers(ctx, parsePerms(m.role_permissions))) throw new HttpError(403, 'This person has more access than you do, so you cannot change it.', 'FORBIDDEN');
    let roleId = m.role_id;
    if ('role_id' in b) {
      const role = roleOf(ctx, int(b.role_id, { min: 1 }));
      if (!covers(ctx, role.permissions)) throw new HttpError(403, 'That role has more access than you do, so you cannot give it to someone.', 'FORBIDDEN');
      roleId = role.id;
    }
    const all = 'all_products' in b ? b.all_products !== false : !!m.all_products;
    const ids = !all && ('product_ids' in b || 'all_products' in b) ? productIds(ctx, 'product_ids' in b ? b.product_ids : db.prepare('SELECT product_id FROM member_products WHERE member_id = ?').all(m.id).map(r => r.product_id)) : null;
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE members SET role_id = ?, all_products = ?, name = ?, disabled = ? WHERE id = ?')
        .run(roleId, all ? 1 : 0, 'name' in b ? str(b.name, 80).trim() : m.name, 'disabled' in b ? (b.disabled ? 1 : 0) : m.disabled, m.id);
      if (all) setScope(m.id, []); else if (ids) setScope(m.id, ids);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(ctx, 'member.update', m.email, JSON.stringify({ role_id: roleId, all_products: all, disabled: 'disabled' in b ? !!b.disabled : undefined }));
    return [200, { ok: true }];
  }, perm);
  route('DELETE', '/api/admin/team/members/:id', async ctx => {
    const m = memberOf(ctx, ctx.params.id);
    if (m.id === ctx.admin.member?.id) throw new HttpError(403, 'You cannot remove yourself.', 'FORBIDDEN');
    if (!covers(ctx, parsePerms(m.role_permissions))) throw new HttpError(403, 'This person has more access than you do, so you cannot remove them.', 'FORBIDDEN');
    db.prepare('DELETE FROM members WHERE id = ?').run(m.id);
    audit(ctx, 'member.remove', m.email);
    return [200, { ok: true }];
  }, perm);
}
