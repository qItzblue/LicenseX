// Roles and permissions.
//
//  - A permission is one thing a person may do ("licenses.block"). The catalogue below is the single source of truth: the
//    server checks against it and the Team page draws its checkboxes from it.
//  - A role is a named set of permissions that belongs to one workspace. Whoever owns the workspace designs its roles.
//  - A member is a person (identified by an email their sign-in provider VERIFIED) holding one role, either for every
//    product or only for the products listed for them. Limiting a member to products limits what they can see and do to
//    the licenses, servers and products linked to those products.
//  - The workspace owner and the site owner always have everything; nothing here restricts them.
import { EMAIL_RE, normEmail } from './auth.js';
import { HOUSE } from './core.js';

/**
 * scoped: still works when the member is limited to some products (it is then limited to those products).
 *         Permissions without it reach across the whole workspace, so a product-limited member never gets them.
 * house:  only meaningful in the site owner's own workspace (they manage the whole service).
 */
export const PERMISSIONS = [
  { key: 'licenses.view', group: 'Licenses', label: 'See licenses', scoped: true },
  { key: 'licenses.create', group: 'Licenses', label: 'Create licenses', scoped: true },
  { key: 'licenses.edit', group: 'Licenses', label: 'Edit licenses (owner, note, server limit, expiry, group, buyer)', scoped: true },
  { key: 'licenses.block', group: 'Licenses', label: 'Block and unblock licenses', scoped: true },
  { key: 'licenses.delete', group: 'Licenses', label: 'Delete licenses', scoped: true },
  { key: 'servers.view', group: 'Servers', label: 'See servers', scoped: true },
  { key: 'servers.manage', group: 'Servers', label: 'Disable, enable and remove servers', scoped: true },
  { key: 'products.view', group: 'Products', label: 'See products and their download links', scoped: true },
  { key: 'products.edit', group: 'Products', label: 'Edit products (upload a new jar, rename, switch on/off, new download link)', scoped: true },
  { key: 'products.create', group: 'Products', label: 'Create new products', scoped: false },
  { key: 'products.delete', group: 'Products', label: 'Delete products', scoped: true },
  { key: 'groups.view', group: 'Groups', label: 'See license groups', scoped: true },
  { key: 'groups.manage', group: 'Groups', label: 'Create, change and delete license groups', scoped: false },
  { key: 'audit.view', group: 'Workspace', label: 'See the activity log', scoped: false },
  { key: 'settings.manage', group: 'Workspace', label: 'Change workspace settings (includes the BuiltByBit secret)', scoped: false },
  { key: 'team.manage', group: 'Workspace', label: 'Manage roles and team members', scoped: false },
  { key: 'platform.customers', group: 'Whole service', label: 'See and manage customers (plans, suspend, invite)', scoped: false, house: true },
  { key: 'platform.site', group: 'Whole service', label: 'Edit the public site name, tagline and links', scoped: false, house: true },
];
const BY_KEY = new Map(PERMISSIONS.map(p => [p.key, p]));
export const ALL_KEYS = PERMISSIONS.map(p => p.key);
export const WORKSPACE_KEYS = PERMISSIONS.filter(p => !p.house).map(p => p.key);

/** Having the second thing without the first would make no sense (you cannot edit what you cannot see), so it comes along. */
const REQUIRES = {
  'licenses.create': ['licenses.view'], 'licenses.edit': ['licenses.view'], 'licenses.block': ['licenses.view'], 'licenses.delete': ['licenses.view'],
  'servers.manage': ['servers.view'],
  'products.edit': ['products.view'], 'products.create': ['products.view'], 'products.delete': ['products.view'],
  'groups.manage': ['groups.view'],
  'platform.customers': [], 'platform.site': [],
};

export class RoleError extends Error {}

/** Validates a list of permission keys and adds the ones they depend on. Returns a sorted, de-duplicated array. */
export function cleanPermissions(input, { house = false } = {}) {
  if (!Array.isArray(input)) throw new RoleError('Permissions must be a list.');
  const out = new Set();
  for (const k of input) {
    const p = BY_KEY.get(k);
    if (!p) throw new RoleError(`Unknown permission "${String(k).slice(0, 40)}".`);
    if (p.house && !house) throw new RoleError(`"${p.label}" only exists in the site owner's own workspace.`);
    out.add(k);
    for (const r of REQUIRES[k] || []) out.add(r);
  }
  return [...out].sort((a, b) => ALL_KEYS.indexOf(a) - ALL_KEYS.indexOf(b));
}

/** Roles every workspace starts with (the owner can change or delete them). */
export const TEMPLATES = [
  { name: 'Administrator', description: 'Everything in the workspace except the plan and billing, which only the owner controls.', permissions: WORKSPACE_KEYS },
  { name: 'Support', description: 'Looks up licenses and servers, blocks bad ones, removes servers.', permissions: ['licenses.view', 'licenses.edit', 'licenses.block', 'servers.view', 'servers.manage', 'products.view', 'groups.view'] },
  { name: 'Developer', description: 'Manages plugin files and download links, can look at licenses.', permissions: ['products.view', 'products.edit', 'products.create', 'licenses.view', 'servers.view', 'groups.view'] },
  { name: 'Viewer', description: 'Read-only.', permissions: ['licenses.view', 'servers.view', 'products.view', 'groups.view', 'audit.view'] },
];

/** The permission set one member really has: what the role says, minus what does not apply to them. */
export function effectivePermissions(rolePermissions, { house, scoped }) {
  let list;
  try { list = JSON.parse(rolePermissions || '[]'); } catch { list = []; }
  return new Set((Array.isArray(list) ? list : []).filter(k => {
    const p = BY_KEY.get(k);
    return p && (!p.house || house) && (!scoped || p.scoped);
  }));
}

// --- who has access to which workspace -----------------------------------------------------------------

/**
 * Every workspace a signed-in person can open: the one they own, then the ones where a member row carries one of their
 * verified emails. (If several of their emails are members of the same workspace the earliest row wins.)
 */
export function slotsFor(db, emails, primary = '') {
  if (!Array.isArray(emails) || !emails.length) return [];
  const marks = emails.map(() => '?').join(',');
  const slots = [];
  const own = db.prepare(`SELECT id, name FROM workspaces WHERE owner_email IN (${marks}) ORDER BY (owner_email = ?) DESC, id LIMIT 1`).get(...emails, primary || '');
  if (own) slots.push({ wsId: own.id, kind: 'owner', name: own.name, role: 'Owner' });
  const seen = new Set(slots.map(s => s.wsId));
  const rows = db.prepare(`SELECT m.id, m.workspace_id, m.email, m.all_products, r.name role_name, r.permissions role_permissions, w.name workspace_name
    FROM members m JOIN roles r ON r.id = m.role_id JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.email IN (${marks}) AND m.disabled = 0 ORDER BY m.id`).all(...emails);
  for (const m of rows) {
    if (seen.has(m.workspace_id)) continue;
    seen.add(m.workspace_id);
    slots.push({ wsId: m.workspace_id, kind: 'member', name: m.workspace_name, role: m.role_name, member: m });
  }
  return slots;
}

/**
 * What the caller may do inside workspace `wsId`:  { perms: Set, scope: null | Set<productId>, owner: boolean }.
 * scope === null means every product; a Set (possibly empty) means only those products.
 */
export function accessFor(db, admin, wsId) {
  if (admin.role === 'platform') return { perms: new Set(ALL_KEYS), scope: null, owner: true };
  if (admin.role === 'tenant') return { perms: new Set(WORKSPACE_KEYS), scope: null, owner: true };
  const m = admin.member;
  const scoped = !m.all_products;
  const perms = effectivePermissions(m.role_permissions, { house: wsId === HOUSE, scoped });
  let scope = null;
  if (scoped) scope = new Set(db.prepare('SELECT mp.product_id id FROM member_products mp JOIN products p ON p.id = mp.product_id WHERE mp.member_id = ? AND p.workspace_id = ?').all(m.id, wsId).map(r => r.id));
  return { perms, scope, owner: false };
}

export { normEmail };
export const validEmail = e => e.length <= 120 && EMAIL_RE.test(e);
