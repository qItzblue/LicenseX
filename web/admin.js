import { h, api, toast, confirmDialog, ago, date, limitText, copy } from '/lib.js';

const $ = id => document.getElementById(id);
const view = $('view');
let groups = [];
const PAGES = { overview: 'Overview', licenses: 'Licenses', servers: 'Servers', groups: 'Groups', settings: 'Settings', audit: 'Audit log' };

// --- auth ------------------------------------------------------------------
async function boot() {
  try { await api('GET', '/api/admin/me'); showApp(); } catch { $('login').hidden = false; $('app').hidden = true; }
}
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('POST', '/api/admin/login', { password: $('pw').value }); $('login').hidden = true; showApp(); }
  catch (err) { $('loginErr').textContent = err.message; $('loginErr').hidden = false; }
});
$('logout').addEventListener('click', async () => { await api('POST', '/api/admin/logout'); location.reload(); });
function showApp() {
  $('app').hidden = false;
  $('nav').replaceChildren(...Object.entries(PAGES).map(([k, label]) => h('a', { 'data-page': k, onclick: () => (location.hash = k) }, label)));
  route();
}
window.addEventListener('hashchange', () => !$('app').hidden && route());

async function route() {
  const page = location.hash.slice(1) in PAGES ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.page === page));
  groups = await api('GET', '/api/admin/groups');
  try { await { overview, licenses, servers, groupsPage, settings, audit }[page](); }
  catch (e) { if (e.status === 401) return location.reload(); toast(e.message, true); }
}
const head = (title, ...actions) => h('div', { class: 'page-head' }, h('h1', null, title), h('div', { class: 'row' }, actions));
const groupTag = id => { const g = groups.find(x => x.id === id); return g ? h('span', { class: 'tag', style: { '--c': g.color } }, g.name) : h('span', { class: 'faint' }, '—'); };
const keyCell = k => h('span', { class: 'keycell' }, k);

// --- overview --------------------------------------------------------------
async function overview() {
  const s = await api('GET', '/api/admin/stats');
  const stat = (n, l) => h('div', { class: 'card stat' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
  const max = Math.max(1, ...s.per_day.map(d => d.n));
  view.replaceChildren(head('Overview'),
    h('div', { class: 'stats' }, stat(s.licenses, 'Licenses'), stat(s.servers, 'Active servers'), stat(s.online, 'Online now'), stat(s.disabled, 'Disabled servers'), stat(s.blocked, 'Blocked licenses'), stat(s.issued_24h, 'Issued last 24h')),
    h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h3', null, 'Licenses issued · 14 days'), h('div', { class: 'bars' }, s.per_day.length ? s.per_day.map(d => h('div', { title: `${d.d}: ${d.n}`, style: { height: d.n / max * 100 + '%' } })) : h('span', { class: 'muted' }, 'No data yet'))),
      h('div', { class: 'card' }, h('h3', { style: { marginBottom: '8px' } }, 'Recent activity'), s.recent.length ? s.recent.map(auditLine) : h('span', { class: 'muted' }, 'Nothing yet'))));
}
const auditLine = a => h('div', { class: 'audit-line' }, h('span', null, h('b', null, a.action), ' ', h('span', { class: 'muted keycell' }, a.target)), h('span', { class: 'faint' }, ago(a.at)));

// --- licenses --------------------------------------------------------------
async function licenses() {
  const filters = { q: '', status: '', group: '' };
  const body = h('div', { class: 'card table-card' });
  async function load() {
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    const rows = await api('GET', '/api/admin/licenses?' + qs);
    body.replaceChildren(h('table', null,
      h('thead', null, h('tr', null, ['License', 'Owner', 'Group', 'Servers', 'Status', 'Issued', 'IP'].map(t => h('th', null, t)))),
      h('tbody', null, rows.length ? rows.map(l => h('tr', { class: 'clickable', onclick: () => licenseDrawer(l.id, load) },
        h('td', null, keyCell(l.key)), h('td', null, l.owner || h('span', { class: 'faint' }, '—')), h('td', null, groupTag(l.group_id)),
        h('td', null, `${l.used} / ${limitText(l.limit)}`), h('td', null, h('span', { class: 'chip ' + l.state }, l.state)),
        h('td', { class: 'muted' }, date(l.created_at)), h('td', { class: 'keycell muted' }, l.issued_ip || '—'))) : h('tr', null, h('td', { colspan: 7, class: 'muted' }, 'No licenses found')))));
  }
  const search = h('input', { placeholder: 'Search key, owner, note, IP…', oninput: debounce(e => { filters.q = e.target.value; load(); }) });
  const status = h('select', { onchange: e => { filters.status = e.target.value; load(); } }, h('option', { value: '' }, 'All statuses'), h('option', { value: 'active' }, 'Active'), h('option', { value: 'blocked' }, 'Blocked'));
  const grp = h('select', { onchange: e => { filters.group = e.target.value; load(); } }, h('option', { value: '' }, 'All groups'), groups.map(g => h('option', { value: g.id }, g.name)));
  view.replaceChildren(head('Licenses', h('button', { class: 'btn primary', onclick: () => licenseForm(null, load) }, '+ New license')), h('div', { class: 'toolbar' }, search, status, grp), body);
  await load();
}
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const groupSelect = sel => h('select', { id: 'f-group' }, h('option', { value: '' }, 'No group (default limit)'), groups.map(g => h('option', { value: g.id, selected: g.id === sel }, `${g.name} (${limitText(g.max_servers)} servers)`)));
const toDateInput = ts => ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '';

function licenseForm(lic, done) {
  const dlg = h('dialog', null,
    h('h3', { style: { marginBottom: '16px' } }, lic ? 'Edit license' : 'New license'),
    h('div', { class: 'field' }, h('label', null, 'Owner'), h('input', { id: 'f-owner', value: lic?.owner || '', placeholder: 'Name, Discord or BuiltByBit user' })),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('label', null, 'Group'), groupSelect(lic?.group_id)),
      h('div', { class: 'field' }, h('label', null, 'Server limit override'), h('input', { id: 'f-max', type: 'number', min: -1, value: lic?.max_servers ?? '', placeholder: 'inherit' }), h('div', { class: 'hint' }, 'Empty = inherit · -1 = unlimited'))),
    h('div', { class: 'field' }, h('label', null, 'Expires'), h('input', { id: 'f-exp', type: 'date', value: toDateInput(lic?.expires_at) })),
    h('div', { class: 'field' }, h('label', null, 'Note'), h('textarea', { id: 'f-note', rows: 2 }, lic?.note || '')),
    h('div', { class: 'row', style: { 'justify-content': 'flex-end' } },
      h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const v = id => dlg.querySelector('#' + id).value;
        const payload = { owner: v('f-owner'), group_id: v('f-group') || null, max_servers: v('f-max') === '' ? null : Number(v('f-max')), expires_at: v('f-exp') ? Math.floor(new Date(v('f-exp') + 'T23:59:59Z') / 1000) : null, note: v('f-note') };
        try {
          const r = lic ? await api('PATCH', `/api/admin/licenses/${lic.id}`, payload) : await api('POST', '/api/admin/licenses', payload);
          dlg.close(); toast(lic ? 'Saved' : `Created ${r.key}`); if (!lic) copy(r.key); done(r);
        } catch (e) { toast(e.message, true); }
      } }, 'Save')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

async function licenseDrawer(id, refresh) {
  document.querySelector('.drawer')?.remove();
  const l = await api('GET', '/api/admin/licenses/' + id);
  const close = () => { drawer.remove(); refresh?.(); };
  const reload = () => { drawer.remove(); licenseDrawer(id, refresh); refresh?.(); };
  const act = (fn, msg) => async () => { try { await fn(); toast(msg); reload(); } catch (e) { toast(e.message, true); } };
  const drawer = h('div', { class: 'drawer' },
    h('div', { class: 'row spread' }, h('h2', { class: 'keycell', style: { fontSize: '18px' } }, l.key), h('button', { class: 'btn ghost sm', onclick: close }, '✕')),
    h('div', { class: 'row wrap', style: { margin: '10px 0 18px' } }, h('span', { class: 'chip ' + l.state }, l.state), groupTag(l.group_id), h('span', { class: 'muted' }, `${l.used} / ${limitText(l.limit)} servers`)),
    l.block_reason && h('div', { class: 'err' }, 'Blocked: ' + l.block_reason),
    h('div', { class: 'muted', style: { marginBottom: '16px' } }, `${l.owner || 'No owner'} · issued ${date(l.created_at)} via ${l.source}${l.issued_ip ? ' from ' + l.issued_ip : ''}${l.expires_at ? ' · expires ' + date(l.expires_at) : ''}`, l.note && h('div', { class: 'faint' }, l.note)),
    h('div', { class: 'row wrap', style: { marginBottom: '22px' } },
      h('button', { class: 'btn sm', onclick: () => copy(l.key) }, 'Copy key'),
      h('button', { class: 'btn sm', onclick: () => licenseForm(l, reload) }, 'Edit / set limit'),
      l.status === 'active'
        ? h('button', { class: 'btn sm danger', onclick: async () => { const r = prompt('Block reason (shown to the plugin owner):', ''); if (r !== null) act(() => api('PATCH', `/api/admin/licenses/${l.id}`, { status: 'blocked', block_reason: r }), 'Blocked')(); } }, 'Block')
        : h('button', { class: 'btn sm', onclick: act(() => api('PATCH', `/api/admin/licenses/${l.id}`, { status: 'active' }), 'Unblocked') }, 'Unblock'),
      h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete license?', 'The license and all its servers are removed permanently. Plugins using it will stop working.', 'Delete')) { await api('DELETE', `/api/admin/licenses/${l.id}`); toast('Deleted'); close(); } } }, 'Delete')),
    h('h3', { style: { marginBottom: '8px' } }, 'Servers'),
    l.servers.filter(s => s.status !== 'removed').length ? l.servers.filter(s => s.status !== 'removed').map(s => h('div', { class: 'audit-line' },
      h('div', null, h('b', null, s.name || 'Unnamed'), ' ', h('span', { class: 'chip ' + s.status }, s.status), h('div', { class: 'muted keycell' }, `${s.ip}:${s.port ?? '?'} · ${ago(s.last_seen)}`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: act(() => api('PATCH', `/api/admin/servers/${s.id}`, { status: s.status === 'disabled' ? 'active' : 'disabled' }), 'Updated') }, s.status === 'disabled' ? 'Enable' : 'Disable'),
        h('button', { class: 'btn sm danger', onclick: act(() => api('DELETE', `/api/admin/servers/${s.id}`), 'Removed') }, 'Remove')))) : h('div', { class: 'muted' }, 'No servers'),
    l.same_ip.length > 0 && h('div', { style: { marginTop: '24px' } }, h('h3', { style: { marginBottom: '8px' } }, `Other licenses issued from ${l.issued_ip}`),
      l.same_ip.map(o => h('div', { class: 'audit-line', style: { cursor: 'pointer' }, onclick: () => licenseDrawer(o.id, refresh) }, keyCell(o.key), h('span', { class: 'faint' }, `${o.owner || '—'} · ${date(o.created_at)}`)))));
  document.body.append(drawer);
}

// --- servers ---------------------------------------------------------------
async function servers() {
  const body = h('div', { class: 'card table-card' });
  async function load(q = '') {
    const rows = await api('GET', '/api/admin/servers?q=' + encodeURIComponent(q));
    const online = Date.now() / 1000 - 40 * 60;
    body.replaceChildren(h('table', null, h('thead', null, h('tr', null, ['Server', 'Address', 'License', 'Version', 'Last seen', 'Status', ''].map(t => h('th', null, t)))),
      h('tbody', null, rows.length ? rows.map(s => h('tr', null,
        h('td', null, h('b', null, s.name || 'Unnamed')), h('td', { class: 'keycell' }, `${s.ip}:${s.port ?? '?'}`),
        h('td', null, keyCell(s.license_key), s.owner && h('div', { class: 'faint' }, s.owner)), h('td', { class: 'muted' }, s.version || '—'), h('td', { class: 'muted' }, ago(s.last_seen)),
        h('td', null, h('span', { class: 'chip ' + (s.status === 'disabled' ? 'disabled' : s.last_seen > online ? 'online' : 'idle') }, s.status === 'disabled' ? 'disabled' : s.last_seen > online ? 'online' : 'idle')),
        h('td', null, h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: async () => { await api('PATCH', `/api/admin/servers/${s.id}`, { status: s.status === 'disabled' ? 'active' : 'disabled' }); load(q); } }, s.status === 'disabled' ? 'Enable' : 'Disable'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Remove server?', 'It will be shut down at its next check-in and the slot freed.', 'Remove')) { await api('DELETE', `/api/admin/servers/${s.id}`); load(q); } } }, 'Remove'))))) : h('tr', null, h('td', { colspan: 7, class: 'muted' }, 'No servers yet')))));
  }
  view.replaceChildren(head('Servers'), h('div', { class: 'toolbar' }, h('input', { placeholder: 'Search name, IP, license, owner…', oninput: debounce(e => load(e.target.value)) })), body);
  await load();
}

// --- groups ----------------------------------------------------------------
async function groupsPage() {
  const edit = g => {
    const dlg = h('dialog', null, h('h3', { style: { marginBottom: '16px' } }, g ? 'Edit group' : 'New group'),
      h('div', { class: 'field' }, h('label', null, 'Name'), h('input', { id: 'g-name', value: g?.name || '', placeholder: 'e.g. Premium, Reseller, Staff' })),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', null, 'Server limit'), h('input', { id: 'g-max', type: 'number', min: -1, value: g?.max_servers ?? 1 }), h('div', { class: 'hint' }, '-1 = unlimited')),
        h('div', { class: 'field' }, h('label', null, 'Color'), h('input', { id: 'g-color', type: 'color', value: g?.color || '#8b5cf6', style: { padding: '3px', height: '42px' } }))),
      h('div', { class: 'row', style: { 'justify-content': 'flex-end' } }, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const payload = { name: dlg.querySelector('#g-name').value, max_servers: Number(dlg.querySelector('#g-max').value), color: dlg.querySelector('#g-color').value };
          try { await (g ? api('PATCH', `/api/admin/groups/${g.id}`, payload) : api('POST', '/api/admin/groups', payload)); dlg.close(); groupsPage(); } catch (e) { toast(e.message, true); }
        } }, 'Save')));
    dlg.addEventListener('close', () => dlg.remove()); document.body.append(dlg); dlg.showModal();
  };
  view.replaceChildren(head('Groups', h('button', { class: 'btn primary', onclick: () => edit(null) }, '+ New group')),
    h('p', { class: 'muted', style: { marginTop: '-12px' } }, 'Groups set a shared server limit. A limit set directly on a license always wins.'),
    h('div', { class: 'card table-card' }, h('table', null, h('thead', null, h('tr', null, ['Group', 'Server limit', 'Licenses', ''].map(t => h('th', null, t)))),
      h('tbody', null, groups.length ? groups.map(g => h('tr', null, h('td', null, h('span', { class: 'tag', style: { '--c': g.color } }, g.name)), h('td', null, limitText(g.max_servers)), h('td', { class: 'muted' }, g.licenses),
        h('td', null, h('div', { class: 'row', style: { 'justify-content': 'flex-end' } }, h('button', { class: 'btn sm', onclick: () => edit(g) }, 'Edit'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete group?', `Licenses in "${g.name}" fall back to the default limit.`, 'Delete')) { await api('DELETE', `/api/admin/groups/${g.id}`); groupsPage(); } } }, 'Delete'))))) : h('tr', null, h('td', { colspan: 4, class: 'muted' }, 'No groups yet'))))));
}

// --- settings --------------------------------------------------------------
async function settings() {
  const s = await api('GET', '/api/admin/settings');
  const save = async patch => { try { await api('PUT', '/api/admin/settings', patch); toast('Saved'); } catch (e) { toast(e.message, true); } };
  const toggle = (k, title, desc) => h('label', { class: 'switch', style: { color: 'inherit', fontSize: '15px', margin: 0 } }, h('span', null, h('b', null, title), h('div', { class: 'muted', style: { fontSize: '13px' } }, desc)),
    h('input', { type: 'checkbox', checked: s[k] === '1', onchange: e => save({ [k]: e.target.checked }) }));
  const num = (k, title, desc, min) => h('div', { class: 'switch' }, h('span', null, h('b', null, title), h('div', { class: 'muted', style: { fontSize: '13px' } }, desc)),
    h('input', { type: 'number', min, value: s[k], style: { width: '100px' }, onchange: e => save({ [k]: Number(e.target.value) }) }));
  view.replaceChildren(head('Settings'), h('div', { class: 'card', style: { maxWidth: '680px' } },
    num('default_limit', 'Default server limit', 'Applies to licenses with no group and no override. -1 = unlimited.', -1),
    num('heartbeat_minutes', 'Plugin check-in interval (minutes)', 'How often running plugins re-validate. Removals and blocks take effect within this window.', 1),
    toggle('claims_enabled', 'Issue licenses on download', 'When off, new downloads cannot claim a license (existing licenses keep working).'),
    toggle('public_removal', 'Let owners remove servers', 'Owners can free a slot from the public license page.')));
}

// --- audit -----------------------------------------------------------------
async function audit() {
  const rows = await api('GET', '/api/admin/audit?limit=200');
  view.replaceChildren(head('Audit log'), h('div', { class: 'card table-card' }, h('table', null, h('thead', null, h('tr', null, ['When', 'Actor', 'Action', 'Target', 'Detail'].map(t => h('th', null, t)))),
    h('tbody', null, rows.map(a => h('tr', null, h('td', { class: 'muted' }, new Date(a.at * 1000).toLocaleString()), h('td', null, a.actor), h('td', null, h('b', null, a.action)), h('td', { class: 'keycell' }, a.target), h('td', { class: 'muted' }, a.detail)))))));
}

boot();
