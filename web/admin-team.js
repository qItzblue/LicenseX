// The Team page: design roles (a named set of permissions) and give people access with them, optionally limited to some products.
// All of this is enforced by the server (server/rbac.js, server/team.js); this page only edits the data.
import { h, api, toast, confirmDialog, ago, copy } from '/lib.js';

const dialog = (title, ...kids) => {
  const dlg = h('dialog', null, h('h3', { style: { marginBottom: '16px' } }, title), ...kids);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
  return dlg;
};
const groupBy = (items, key) => items.reduce((m, x) => ((m[x[key]] ||= []).push(x), m), {});

export async function teamPage({ render, head }) {
  const t = await api('GET', '/api/admin/team');
  const productName = new Map(t.products.map(p => [p.id, p.name]));
  const roleById = new Map(t.roles.map(r => [r.id, r]));
  const reload = () => teamPage({ render, head });
  const failing = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  // ---- role editor ------------------------------------------------------------------------------------------
  function roleDialog(role) {
    const have = new Set(role?.permissions || []);
    const boxes = new Map();
    const groups = groupBy(t.permissions, 'group');
    const sync = changed => {
      // what a permission needs comes along (the server does the same)
      const needs = { 'licenses.create': ['licenses.view'], 'licenses.edit': ['licenses.view'], 'licenses.block': ['licenses.view'], 'licenses.delete': ['licenses.view'], 'servers.manage': ['servers.view'],
        'products.edit': ['products.view'], 'products.create': ['products.view'], 'products.delete': ['products.view'], 'groups.manage': ['groups.view'] };
      if (changed && boxes.get(changed).checked) for (const k of needs[changed] || []) if (boxes.get(k)) boxes.get(k).checked = true;
      if (changed && !boxes.get(changed).checked) for (const [k, deps] of Object.entries(needs)) if (deps.includes(changed) && boxes.get(k)) boxes.get(k).checked = false;
    };
    const list = Object.entries(groups).map(([name, perms]) => h('fieldset', { class: 'perm-group' }, h('legend', null, name),
      perms.map(p => {
        const box = h('input', { type: 'checkbox', checked: have.has(p.key), disabled: !p.held, onchange: () => sync(p.key) });
        boxes.set(p.key, box);
        return h('label', { class: 'perm-row' + (p.held ? '' : ' off'), title: p.held ? '' : 'You do not have this permission yourself, so you cannot hand it out.' }, box,
          h('span', null, p.label, p.scoped ? h('span', { class: 'perm-tag', title: 'Also works for people limited to some products, for those products only' }, 'per product') : null));
      })));
    const dlg = dialog(role ? `Edit role: ${role.name}` : 'New role',
      h('div', { class: 'field' }, h('label', null, 'Name'), h('input', { id: 'r-name', value: role?.name || '', placeholder: 'e.g. Support, Moderator, Accountant', maxlength: 40 })),
      h('div', { class: 'field' }, h('label', null, 'Description (optional)'), h('input', { id: 'r-desc', value: role?.description || '', maxlength: 140 })),
      h('p', { class: 'hint', style: { margin: '4px 0 10px' } }, 'Tick what people with this role may do. Anything not ticked is blocked. Permissions marked "per product" also work when a person is limited to some products; the others reach across the whole workspace, so limited people never get them.'),
      h('div', { class: 'perm-list' }, list),
      h('div', { class: 'row', style: { 'justify-content': 'flex-end', 'margin-top': '16px' } },
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: failing(async () => {
          const payload = { name: dlg.querySelector('#r-name').value, description: dlg.querySelector('#r-desc').value, permissions: [...boxes].filter(([, b]) => b.checked).map(([k]) => k) };
          // permissions this person cannot hand out stay as the role had them (they are disabled, so they are not in the list)
          if (role) for (const k of role.permissions) if (!boxes.get(k) || boxes.get(k).disabled) payload.permissions.push(k);
          await (role ? api('PATCH', `/api/admin/team/roles/${role.id}`, payload) : api('POST', '/api/admin/team/roles', payload));
          dlg.close(); toast('Saved'); reload();
        }) }, 'Save role')));
  }

  // ---- member editor ------------------------------------------------------------------------------------------
  function memberDialog(m) {
    const usable = t.roles.filter(r => r.editable || r.id === m?.role_id);
    if (!usable.length) return toast('Create a role first (you can only give out roles that do not exceed your own access).', true);
    const limited = h('input', { type: 'radio', name: 'scope', checked: m ? !m.all_products : false });
    const all = h('input', { type: 'radio', name: 'scope', checked: m ? m.all_products : true });
    const checks = t.products.map(p => h('label', { class: 'perm-row' }, h('input', { type: 'checkbox', value: p.id, checked: m?.product_ids.includes(p.id) }), h('span', null, p.name)));
    const box = h('div', { class: 'perm-list', hidden: !limited.checked }, checks.length ? checks : h('div', { class: 'muted' }, 'No products yet.'));
    for (const r of [all, limited]) r.addEventListener('change', () => { box.hidden = !limited.checked; });
    const roleSel = h('select', { id: 'm-role' }, usable.map(r => h('option', { value: r.id, selected: r.id === (m?.role_id ?? usable[0].id) }, r.name)));
    const dlg = dialog(m ? `Edit ${m.email}` : 'Add a person',
      !m && h('div', { class: 'field' }, h('label', null, 'Email'), h('input', { id: 'm-email', type: 'email', placeholder: 'person@example.com', autocomplete: 'off' }),
        h('div', { class: 'hint' }, 'They sign in with Google, Discord or GitHub using this email address and get access automatically. The sign-in provider must have verified the address.')),
      h('div', { class: 'field' }, h('label', null, 'Name (optional)'), h('input', { id: 'm-name', value: m?.name || '', maxlength: 80 })),
      h('div', { class: 'field' }, h('label', null, 'Role'), roleSel),
      h('div', { class: 'field' }, h('label', null, 'Which products?'),
        h('label', { class: 'perm-row' }, all, h('span', null, 'All products')),
        h('label', { class: 'perm-row' }, limited, h('span', null, 'Only these products')), box,
        h('div', { class: 'hint' }, 'A person limited to products only sees the licenses, servers and products linked to them. Licenses not linked to any product stay hidden from them.')),
      h('div', { class: 'row', style: { 'justify-content': 'flex-end' } },
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: failing(async () => {
          const payload = { name: dlg.querySelector('#m-name').value, role_id: Number(roleSel.value), all_products: all.checked,
            product_ids: checks.map(c => c.querySelector('input')).filter(i => i.checked).map(i => Number(i.value)) };
          if (m) await api('PATCH', `/api/admin/team/members/${m.id}`, payload);
          else await api('POST', '/api/admin/team/members', { ...payload, email: dlg.querySelector('#m-email').value });
          dlg.close(); toast(m ? 'Saved' : 'Added. Send them the sign-in link.'); reload();
        }) }, m ? 'Save' : 'Add person')));
  }

  // ---- page ---------------------------------------------------------------------------------------------------
  const signInUrl = `${location.origin}/login/creator`;
  const accessCell = m => m.all_products ? h('span', { class: 'muted' }, 'All products')
    : h('span', { class: 'scope-chips' }, m.product_ids.length ? m.product_ids.map(id => h('span', { class: 'chip' }, productName.get(id) || 'deleted product')) : h('span', { class: 'faint' }, 'nothing'));
  const people = h('div', { class: 'card table-card' }, h('table', null,
    h('thead', null, h('tr', null, ['Person', 'Role', 'Access', 'Last sign-in', ''].map(x => h('th', null, x)))),
    h('tbody', null,
      t.owner && h('tr', null, h('td', null, h('b', null, t.owner.name || t.owner.email), h('div', { class: 'faint' }, t.owner.email)), h('td', null, h('span', { class: 'chip active' }, 'Owner')), h('td', { class: 'muted' }, 'Everything'), h('td', { class: 'faint' }, ''), h('td', null)),
      t.members.length ? t.members.map(m => h('tr', { class: m.disabled ? 'dim' : '' },
        h('td', null, h('b', null, m.name || m.email), m.name && h('div', { class: 'faint' }, m.email), m.disabled && h('span', { class: 'chip disabled', style: { marginLeft: '6px' } }, 'switched off')),
        h('td', null, m.role_name), h('td', null, accessCell(m)), h('td', { class: 'muted' }, m.last_login ? ago(m.last_login) : 'never'),
        h('td', null, m.editable ? h('div', { class: 'row', style: { 'justify-content': 'flex-end' } },
          h('button', { class: 'btn sm', onclick: () => memberDialog(m) }, 'Edit'),
          h('button', { class: 'btn sm', onclick: failing(async () => { await api('PATCH', `/api/admin/team/members/${m.id}`, { disabled: !m.disabled }); toast(m.disabled ? 'Switched on' : 'Switched off'); reload(); }) }, m.disabled ? 'Switch on' : 'Switch off'),
          h('button', { class: 'btn sm danger', onclick: failing(async () => { if (await confirmDialog('Remove this person?', `${m.email} loses access straight away.`, 'Remove')) { await api('DELETE', `/api/admin/team/members/${m.id}`); toast('Removed'); reload(); } }) }, 'Remove')) : h('span', { class: 'faint' }, m.id === t.you.member_id ? 'you' : 'more access than you')))
      ) : h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'Nobody else has access yet. Add a person and give them a role.')))));

  const roleCard = r => h('div', { class: 'card role' },
    h('div', { class: 'row spread' }, h('b', { style: { fontSize: '16px' } }, r.name), h('span', { class: 'muted' }, `${r.members} ${r.members === 1 ? 'person' : 'people'}`)),
    r.description && h('div', { class: 'muted', style: { margin: '4px 0 10px' } }, r.description),
    h('div', { class: 'scope-chips', style: { margin: '8px 0 14px' } }, r.permissions.length ? r.permissions.map(k => h('span', { class: 'chip', title: k }, t.permissions.find(p => p.key === k)?.label.split(' (')[0] || k)) : h('span', { class: 'faint' }, 'No permissions')),
    r.editable ? h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => roleDialog(r) }, 'Edit'),
      h('button', { class: 'btn sm danger', onclick: failing(async () => { if (await confirmDialog('Delete this role?', `"${r.name}" is removed. This only works when nobody has it.`, 'Delete')) { await api('DELETE', `/api/admin/team/roles/${r.id}`); toast('Deleted'); reload(); } }) }, 'Delete'))
      : h('div', { class: 'faint' }, 'Has more access than you, so you cannot change it'));

  render(head('Team', h('button', { class: 'btn', onclick: () => roleDialog(null) }, '+ New role'), h('button', { class: 'btn primary', onclick: () => memberDialog(null) }, '+ Add person')),
    h('p', { class: 'muted', style: { marginTop: '-12px' } }, 'Give people access to this workspace. A role decides what they may do; you can also limit a person to certain products. People sign in at ',
      h('a', { href: signInUrl, onclick: e => { e.preventDefault(); copy(signInUrl); toast('Sign-in link copied'); } }, signInUrl), ' (click to copy).'),
    h('h3', { style: { margin: '18px 0 10px' } }, 'People'), people,
    h('h3', { style: { margin: '28px 0 10px' } }, 'Roles'),
    h('div', { class: 'product-grid' }, t.roles.length ? t.roles.map(roleCard) : h('div', { class: 'muted' }, 'No roles yet. Create one to start adding people.')));
}
