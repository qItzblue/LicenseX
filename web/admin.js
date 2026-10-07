import { h, api, toast, confirmDialog, ago, date, limitText, copy, currentWs, setWs, wsHeaders, wsq } from '/lib.js';

const $ = id => document.getElementById(id);
const view = $('view');
/** Like replaceChildren, but skips null/false (the native one would print them as text). */
const render = (...nodes) => view.replaceChildren(...nodes.flat().filter(n => n != null && n !== false));
let groups = [];
const PAGES_PLATFORM = { overview: 'Overview', licenses: 'Licenses', servers: 'Servers', products: 'Products', build: 'Build', groups: 'Groups', customers: 'Customers', plans: 'Plans', settings: 'Settings', audit: 'Audit log' };
const PAGES_TENANT = { overview: 'Overview', licenses: 'Licenses', servers: 'Servers', products: 'Products', groups: 'Groups', billing: 'Billing', settings: 'Settings', audit: 'Audit log' };
let PAGES = PAGES_TENANT;
const isDash = location.pathname === '/dashboard';
let WS = null;   // the workspace being shown (refreshed on every page change)

// --- auth ------------------------------------------------------------------
async function boot() {
  try { const me = await api('GET', '/api/admin/me'); window.__me = me; showApp(); }
  catch { await showLogin(); }
}
async function showLogin() {
  $('login').hidden = false; $('app').hidden = true;
  let auth = { providers: [], password_login: true, user: null };
  try { auth = await api('GET', '/api/auth/me'); } catch {}
  // a signed-in customer opening the dashboard for the first time gets their free account straight away
  if (isDash && auth.user && !auth.user.isAdmin && !auth.user.workspace && auth.user.email) {
    try { await api('POST', '/api/workspace/ensure'); return location.reload(); } catch (e) { $('notAdmin').textContent = e.message; $('notAdmin').hidden = false; }
  }
  $('loginTitle').textContent = isDash ? 'Sign in to your dashboard' : 'Admin sign in';
  $('oauth').replaceChildren(...auth.providers.map(p => h('a', { class: 'oauth-btn', href: `/auth/${p.id}?next=${isDash ? '/dashboard' : '/admin'}` },
    h('span', { class: `logo ${p.id}` }, p.label.charAt(0)), `Continue with ${p.label}`)));
  $('oauth').hidden = !auth.providers.length;
  const showPw = auth.password_login && !isDash;
  $('loginForm').hidden = !showPw;
  $('or').hidden = !(auth.providers.length && showPw);
  if (isDash && !auth.user) { $('hintNew').hidden = false; }
  if (auth.user && !auth.user.isAdmin && !isDash) {
    $('notAdmin').textContent = auth.user.email
      ? `${auth.user.email} is signed in but is not on the admin list.`
      : `${auth.user.name} is signed in with ${auth.user.provider}, which shared no verified email, so it can't be an admin.`;
    $('notAdmin').hidden = false;
  }
}
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('POST', '/api/admin/login', { password: $('pw').value }); $('login').hidden = true; showApp(); }
  catch (err) { $('loginErr').textContent = err.message; $('loginErr').hidden = false; }
});
$('logout').addEventListener('click', async () => { await api('POST', '/api/auth/logout'); location.href = '/'; });
function showApp() {
  $('app').hidden = false;
  const me = window.__me;
  PAGES = me.role === 'platform' ? PAGES_PLATFORM : PAGES_TENANT;
  document.title = me.role === 'platform' ? 'Admin' : 'Dashboard';
  if (me) $('whoami').textContent = me.email ? `${me.name} (${me.email})` : me.name;
  $('nav').replaceChildren(...Object.entries(PAGES).map(([k, label]) => h('a', { 'data-page': k, onclick: () => (location.hash = k) }, label)));
  if (me.role === 'platform') workspaceSwitcher();
  route();
}
window.addEventListener('hashchange', () => !$('app').hidden && route());

/** The owner can open any customer's workspace (to help them, or to check an issue). */
async function workspaceSwitcher() {
  const box = $('wsSwitch');
  let customers = [];
  try { customers = (await api('GET', '/api/admin/customers')).filter(c => !c.house); } catch { return; }
  if (!customers.length) { box.hidden = true; return; }
  const sel = h('select', { style: { fontSize: '13px' }, onchange: e => { setWs(e.target.value); location.hash = 'overview'; location.reload(); } },
    h('option', { value: '' }, 'My workspace'), customers.map(c => h('option', { value: c.id, selected: String(c.id) === currentWs() }, `${c.name} · ${c.owner_email}`)));
  box.replaceChildren(h('label', { style: { fontSize: '12px', marginBottom: '4px' } }, 'Workspace'), sel);
  box.hidden = false;
}

let buildTimer;
async function route() {
  clearInterval(buildTimer);
  const page = location.hash.slice(1) in PAGES ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.page === page));
  try {
    WS = await api('GET', '/api/workspace');
    window.__me.workspace = { ...window.__me.workspace, ...WS };
    banner();
    groups = await api('GET', '/api/admin/groups');
    await { overview, licenses, servers, products, build: buildPage, groups: groupsPage, customers: customersPage, plans: plansPage, billing: billingPage, settings, audit }[page]();
  } catch (e) { if (e.status === 401) return location.reload(); toast(e.message, true); }
}

/** Notices that apply to every page: viewing someone else's workspace, suspension, a lapsed plan. */
function banner() {
  const me = window.__me, box = $('banner'), items = [];
  if (me.role === 'platform' && !WS.house) items.push(['warn', h('span', null, h('b', null, `Viewing ${WS.name}'s workspace`), ` (${WS.owner_email}) as the site owner. What you change here changes their account. `), h('button', { class: 'btn sm', onclick: () => { setWs(''); location.hash = 'overview'; location.reload(); } }, 'Back to my workspace')]);
  if (WS.suspended) items.push(['bad', h('span', null, h('b', null, 'This account is suspended. '), WS.suspended_reason || 'Contact support.', ' You can look around, but nothing can be changed and its licenses are blocked.')]);
  else if (WS.lapsed) items.push(['warn', h('span', null, h('b', null, 'Your paid plan has ended. '), 'Existing licenses keep working, but you cannot add more than the Free plan allows. '), h('a', { class: 'btn sm primary', href: '#billing' }, 'Renew')]);
  else if (WS.plan_status === 'past_due') items.push(['warn', h('span', null, h('b', null, 'Your last payment failed. '), 'Update your card before the period ends to keep your plan. '), WS.billing.can_portal ? h('a', { class: 'btn sm primary', href: '#billing' }, 'Fix billing') : null]);
  box.replaceChildren(...items.map(([kind, ...kids]) => h('div', { class: 'notice ' + kind }, ...kids)));
}
const head = (title, ...actions) => h('div', { class: 'page-head' }, h('h1', null, title), h('div', { class: 'row' }, actions));
const groupTag = id => { const g = groups.find(x => x.id === id); return g ? h('span', { class: 'tag', style: { '--c': g.color } }, g.name) : h('span', { class: 'faint' }, '—'); };
const keyCell = k => h('span', { class: 'keycell' }, k);

// --- overview --------------------------------------------------------------
async function overview() {
  const s = await api('GET', '/api/admin/stats');
  const stat = (n, l) => h('div', { class: 'card stat' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
  const max = Math.max(1, ...s.per_day.map(d => d.n));
  render(head('Overview'), WS.house ? null : planCard(),
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
  render(head('Licenses', h('button', { class: 'btn primary', onclick: () => licenseForm(null, load) }, '+ New license')), h('div', { class: 'toolbar' }, search, status, grp), body);
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
  const hb = Number((await api('GET', '/api/admin/settings')).heartbeat_minutes) || 1;
  const body = h('div', { class: 'card table-card' });
  async function load(q = '') {
    const rows = await api('GET', '/api/admin/servers?q=' + encodeURIComponent(q));
    const online = Date.now() / 1000 - Math.max(3, hb * 3) * 60; // 3 missed check-ins = idle
    body.replaceChildren(h('table', null, h('thead', null, h('tr', null, ['Server', 'Address', 'License', 'Version', 'Last seen', 'Status', ''].map(t => h('th', null, t)))),
      h('tbody', null, rows.length ? rows.map(s => h('tr', null,
        h('td', null, h('b', null, s.name || 'Unnamed')), h('td', { class: 'keycell' }, `${s.ip}:${s.port ?? '?'}`),
        h('td', null, keyCell(s.license_key), s.owner && h('div', { class: 'faint' }, s.owner)), h('td', { class: 'muted' }, s.version || '—'), h('td', { class: 'muted' }, ago(s.last_seen)),
        h('td', null, h('span', { class: 'chip ' + (s.status === 'disabled' ? 'disabled' : s.last_seen > online ? 'online' : 'idle') }, s.status === 'disabled' ? 'disabled' : s.last_seen > online ? 'online' : 'idle')),
        h('td', null, h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: async () => { await api('PATCH', `/api/admin/servers/${s.id}`, { status: s.status === 'disabled' ? 'active' : 'disabled' }); load(q); } }, s.status === 'disabled' ? 'Enable' : 'Disable'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Remove server?', 'It will be shut down at its next check-in and the slot freed.', 'Remove')) { await api('DELETE', `/api/admin/servers/${s.id}`); load(q); } } }, 'Remove'))))) : h('tr', null, h('td', { colspan: 7, class: 'muted' }, 'No servers yet')))));
  }
  render(head('Servers'), h('div', { class: 'toolbar' }, h('input', { placeholder: 'Search name, IP, license, owner…', oninput: debounce(e => load(e.target.value)) })), body);
  await load();
}

// --- products (plugin downloads) -------------------------------------------
async function uploadFile(id, file) {
  const r = await fetch(`/api/admin/products/${id}/file`, { method: 'POST', headers: { 'X-Filename': file.name, ...wsHeaders() }, body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.message || 'Upload failed'), { status: r.status });
  return data;
}
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';

async function products() {
  const list = await api('GET', '/api/admin/products');
  const grid = h('div', { class: 'product-grid' });

  const drop = h('div', { class: 'dropzone', tabindex: 0 },
    h('input', { type: 'file', id: 'file', accept: '.jar,.zip', hidden: true }),
    h('div', { class: 'dz-icon' }, '⬆'),
    h('div', null, h('b', null, 'Drop your plugin .jar here'), h('div', { class: 'muted' }, 'or click to browse · LicenseX adds the license check for you, no code changes needed')));
  const fileEl = drop.querySelector('#file');
  const pick = () => fileEl.click();
  drop.addEventListener('click', e => { if (e.target !== fileEl) pick(); });
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); if (ev !== 'drop') drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => e.dataTransfer.files[0] && createFromFile(e.dataTransfer.files[0]));
  fileEl.addEventListener('change', () => fileEl.files[0] && createFromFile(fileEl.files[0]));

  async function createFromFile(file) {
    if (!/\.(jar|zip)$/i.test(file.name)) return toast('Please choose a .jar or .zip file', true);
    drop.classList.add('busy'); drop.classList.remove('over');
    try {
      const name = file.name.replace(/\.(jar|zip)$/i, '');
      const p = await api('POST', '/api/admin/products', { name });
      await uploadFile(p.id, file);
      toast(`Uploaded ${file.name}`); products();
    } catch (e) { toast(e.message, true); drop.classList.remove('busy'); }
  }

  grid.replaceChildren(...(list.length ? list.map(productCard) : [h('div', { class: 'muted', style: { padding: '8px' } }, 'No products yet. Drop a plugin jar above to create your first licensed download.')]));
  render(head('Products'),
    h('p', { class: 'muted', style: { marginTop: '-12px' } }, 'Upload your finished plugin jar as it is. LicenseX wraps it so it checks its buyer\'s license before starting, and hands each buyer their own copy with the license built in. For BuiltByBit, use the BuiltByBit build button.'),
    drop, grid);
}

function productCard(p) {
  const refresh = () => products();
  const patch = (body, msg) => async () => { try { await api('PATCH', `/api/admin/products/${p.id}`, body); toast(msg); refresh(); } catch (e) { toast(e.message, true); } };
  const replaceInput = h('input', { type: 'file', accept: '.jar,.zip', hidden: true, onchange: async e => { if (e.target.files[0]) { try { await uploadFile(p.id, e.target.files[0]); toast('File replaced'); refresh(); } catch (err) { toast(err.message, true); } } } });
  return h('div', { class: 'card product' },
    h('div', { class: 'row spread' },
      h('div', { class: 'row', style: { gap: '12px' } }, h('div', { class: 'product-ico' }, '📦'),
        h('div', null, h('b', { style: { fontSize: '16px' } }, p.name),
          h('div', { class: 'muted', style: { fontSize: '13px' } }, p.has_file ? `${p.filename} · ${fmtSize(p.size)}` : 'No file uploaded yet'))),
      h('div', { class: 'row wrap', style: { gap: '6px', justifyContent: 'flex-end' } },
        (() => { const blocked = p.integration && !p.integration.ok && !p.integration.integrated;
          return h('span', { class: 'chip ' + (p.enabled && p.has_file && !blocked ? 'active' : 'disabled') }, !p.enabled ? 'Disabled' : !p.has_file ? 'No file' : blocked ? 'Blocked' : 'Live'); })(),
        p.group_id && groupTag(p.group_id))),
    integrationNote(p),
    h('div', { class: 'row wrap', style: { gap: '18px', margin: '14px 0', color: 'var(--muted)', fontSize: '13px' } },
      h('span', null, h('b', { style: { color: 'var(--text)', fontSize: '18px' } }, p.downloads), ' downloads'),
      h('span', null, 'Licenses issued per download · ', p.group_id ? 'assigned to group' : 'default limit')),
    h('label', { style: { marginTop: '4px' } }, 'Direct download URL (your own site or Discord; add &user=<buyer id> to keep one license per buyer)'),
    h('div', { class: 'url-row' }, h('input', { class: 'mono', readonly: true, value: p.download_url, onclick: e => e.target.select() }),
      h('button', { class: 'btn sm', onclick: () => copy(p.download_url) }, 'Copy')),
    h('div', { class: 'row wrap', style: { marginTop: '14px', gap: '8px' } },
      h('a', { class: 'btn sm primary', href: p.download_url, target: '_blank' }, '⬇ Test download'),
      p.has_file && p.integration && (p.integration.ok || p.integration.integrated) && h('a', { class: 'btn sm', href: wsq(`/api/admin/products/${p.id}/bbb-build`), title: 'The jar to upload to BuiltByBit. BuiltByBit fills in each buyer\'s key.' }, '⬇ BuiltByBit build'),
      h('button', { class: 'btn sm', onclick: () => replaceInput.click() }, p.has_file ? 'Replace file' : 'Upload file'), replaceInput,
      h('button', { class: 'btn sm', onclick: () => productEdit(p) }, 'Edit'),
      h('button', { class: 'btn sm', onclick: patch({ enabled: !p.enabled }, p.enabled ? 'Disabled' : 'Enabled') }, p.enabled ? 'Disable' : 'Enable'),
      h('button', { class: 'btn sm', onclick: async () => { if (await confirmDialog('Regenerate download token?', 'The old BuiltByBit URL stops working immediately. Update your resource with the new URL.', 'Regenerate', false)) patch({ regenerate_token: true }, 'New token generated')(); } }, 'New token'),
      h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete product?', `"${p.name}" and its uploaded file are removed. Issued licenses are not affected.`, 'Delete')) { await api('DELETE', `/api/admin/products/${p.id}`); toast('Deleted'); refresh(); } } }, 'Delete')));
}

function integrationNote(p) {
  const i = p.integration;
  if (!i) return null;
  const box = (cls, title, text) => h('div', { class: 'integ ' + cls }, h('b', null, title), h('span', null, text));
  if (i.integrated) return box('ok', 'Already integrated', 'This plugin contains the LicenseX client, so it is served as is with the buyer\'s license file.');
  if (i.ok) return box('ok', 'Auto-integrated', `The license check is added around ${i.main} automatically. The plugin itself is not modified.`);
  return box('bad', 'Cannot be integrated, so downloads are blocked', i.message || 'This jar can\'t be wrapped.');
}

function productEdit(p) {
  const dlg = h('dialog', null, h('h3', { style: { marginBottom: '16px' } }, 'Edit product'),
    h('div', { class: 'field' }, h('label', null, 'Name'), h('input', { id: 'p-name', value: p.name })),
    h('div', { class: 'field' }, h('label', null, 'Assign issued licenses to group'), groupSelect(p.group_id),
      h('div', { class: 'hint' }, 'Buyers of this product get a license in this group, inheriting its server limit.')),
    h('div', { class: 'row', style: { 'justify-content': 'flex-end' } }, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        try { await api('PATCH', `/api/admin/products/${p.id}`, { name: dlg.querySelector('#p-name').value, group_id: dlg.querySelector('#f-group').value || null }); dlg.close(); toast('Saved'); products(); }
        catch (e) { toast(e.message, true); }
      } }, 'Save')));
  dlg.addEventListener('close', () => dlg.remove()); document.body.append(dlg); dlg.showModal();
}

// --- build from source ------------------------------------------------------
const SEV = { high: ['blocked', 'High'], medium: ['idle', 'Medium'], info: ['', 'Info'] };

async function buildPage() {
  const tools = await api('GET', '/api/admin/builds/tools').catch(() => ({}));
  const list = h('div', { class: 'build-list' });
  const products = await api('GET', '/api/admin/products');
  const toolChip = (label, v) => h('span', { class: 'chip ' + (v ? 'active' : 'blocked') }, v ? `${label} ${v}` : `${label} not installed`);

  const drop = h('div', { class: 'dropzone', tabindex: 0 },
    h('input', { type: 'file', accept: '.zip', hidden: true }),
    h('div', { class: 'dz-icon' }, '⬆'),
    h('div', null, h('b', null, 'Drop your plugin source here (.zip)'), h('div', { class: 'muted' }, 'A Maven or Gradle project. LicenseX inspects it first, and nothing is built until you press Build.')));
  const fileEl = drop.querySelector('input');
  drop.addEventListener('click', e => { if (e.target !== fileEl) fileEl.click(); });
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileEl.click(); } });
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); if (ev !== 'drop') drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => e.dataTransfer.files[0] && send(e.dataTransfer.files[0]));
  fileEl.addEventListener('change', () => fileEl.files[0] && send(fileEl.files[0]));

  async function send(file) {
    if (!/\.zip$/i.test(file.name)) return toast('Please choose a .zip of your project', true);
    drop.classList.add('busy'); drop.classList.remove('over');
    try {
      const r = await fetch('/api/admin/builds', { method: 'POST', headers: { 'X-Filename': file.name, ...wsHeaders() }, body: file });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Upload failed');
      toast('Inspected ' + file.name); await refresh();
    } catch (e) { toast(e.message, true); }
    drop.classList.remove('busy');
  }

  async function refresh() {
    const jobs = await api('GET', '/api/admin/builds');
    list.replaceChildren(...(jobs.length ? jobs.map(j => jobCard(j, products, refresh)) : [h('div', { class: 'muted', style: { padding: '8px' } }, 'Nothing here yet. Drop a source zip above.')]));
    if (jobs.some(j => j.status === 'building')) { clearInterval(buildTimer); buildTimer = setInterval(refresh, 2000); }
    else clearInterval(buildTimer);
  }

  render(head('Build from source'),
    h('p', { class: 'muted', style: { marginTop: '-12px' } }, 'Upload your plugin\'s source and get the compiled jar back, ready to use as a product. Jars are kept for 24 hours.'),
    h('div', { class: 'row wrap', style: { marginBottom: '14px' } }, toolChip('Java', tools.java), toolChip('Maven', tools.maven), toolChip('Gradle', tools.gradle),
      !tools.java && h('span', { class: 'muted', style: { fontSize: '13px' } }, 'This server cannot compile yet. Setup: docs/BUILD.md')),
    h('div', { class: 'integ bad', style: { marginTop: 0, marginBottom: '16px' } }, h('b', null, 'Only build code you trust'),
      h('span', null, 'Building runs Maven or Gradle on this server, and a project can run its own code while it builds. LicenseX shows what it finds and asks you to confirm anything risky, but it is not a sandbox. Do not build strangers\' code on a server that also holds your licenses.')),
    drop, list);
  await refresh();
}

function jobCard(j, products, refresh) {
  const r = j.report || {};
  const statusChip = { inspected: ['idle', 'Ready to build'], building: ['online', 'Building…'], done: ['active', 'Built'], failed: ['blocked', 'Failed'] }[j.status] || ['', j.status];
  const kv = (k, v) => v ? h('div', { class: 'kv' }, h('span', null, k), h('b', null, v)) : null;
  const trust = h('input', { type: 'checkbox', id: 'trust-' + j.id });
  const findings = r.findings || [];
  const call = async (method, path, body, msg) => { try { await api(method, path, body); if (msg) toast(msg); await refresh(); } catch (e) { toast(e.message, true); } };

  const card = h('div', { class: 'card build' },
    h('div', { class: 'row spread wrap' },
      h('div', null, h('b', { style: { fontSize: '16px' } }, r.plugin?.name || j.filename), h('div', { class: 'muted', style: { fontSize: '13px' } }, `${j.filename} · ${ago(Math.floor(j.createdAt / 1000))}`)),
      h('span', { class: 'chip ' + statusChip[0] }, statusChip[1])),
    h('div', { class: 'kvs' },
      kv('Project', r.kind === 'none' ? 'not buildable' : `${r.kind}${r.java ? ' · Java ' + r.java : ''}`),
      kv('Plugin', r.plugin ? `${r.plugin.name || '?'} ${r.plugin.version || ''}`.trim() : 'no plugin.yml'),
      kv('Main class', r.plugin?.main ? `${r.plugin.main}${r.mainFound === false ? ' (not found!)' : ''}` : ''),
      kv('API', [r.plugin?.apiVersion && `api ${r.plugin.apiVersion}`, (r.deps || []).join(', ')].filter(Boolean).join(' · ')),
      kv('Size', `${r.javaFiles} source files · ${r.lines.toLocaleString()} lines`)),
    (r.warnings || []).map(w => h('div', { class: 'integ bad' }, h('span', null, w))),
    findings.length ? h('details', { class: 'findings', open: findings.some(f => f.sev === 'high') },
      h('summary', null, `${findings.length} thing${findings.length === 1 ? '' : 's'} worth a look`, ` (${findings.filter(f => f.sev === 'high').length} high, ${findings.filter(f => f.sev === 'medium').length} medium)`),
      h('div', { class: 'muted', style: { fontSize: '12px', margin: '6px 0' } }, 'Automatic scan for risky calls. A clean scan does not prove the code is safe, and a finding is not proof it is malicious: read the code.'),
      findings.map(f => h('div', { class: 'finding' },
        h('span', { class: 'chip ' + SEV[f.sev][0] }, SEV[f.sev][1]),
        h('div', null, h('b', null, f.title), h('div', { class: 'mono muted', style: { fontSize: '12px', wordBreak: 'break-all' } }, `${f.file}:${f.line}`), h('code', { class: 'snip' }, f.snippet))))) : h('div', { class: 'muted', style: { fontSize: '13px', margin: '10px 0' } }, 'No risky calls found by the automatic scan.'),
    (r.network || []).length ? h('div', { class: 'muted', style: { fontSize: '13px', marginBottom: '10px' } }, 'Contacts these addresses: ', (r.network || []).map(n => h('span', { class: 'tag', style: { marginRight: '4px' } }, n))) : null,
    j.log ? h('pre', { class: 'logbox', id: 'log-' + j.id }, j.log) : null,
    j.error ? h('div', { class: 'integ bad' }, h('b', null, 'Build failed'), h('span', null, j.error)) : null);

  const actions = h('div', { class: 'row wrap', style: { marginTop: '12px', gap: '8px' } });
  if (j.status === 'inspected' || j.status === 'failed') {
    if (r.needsTrust) actions.append(h('label', { class: 'trustbox' }, trust, 'I have read the findings and trust this code'));
    actions.append(h('button', { class: 'btn primary', disabled: r.kind === 'none', onclick: () => { if (r.needsTrust && !trust.checked) return toast('Tick the box to confirm you trust this code', true); call('POST', `/api/admin/builds/${j.id}/build`, { trust: r.needsTrust && trust.checked }); } }, j.status === 'failed' ? 'Build again' : 'Build jar'));
  }
  if (j.status === 'building') actions.append(h('span', { class: 'muted' }, 'Building… the first build downloads dependencies and can take a few minutes.'));
  if (j.status === 'done' && j.jar) {
    const sel = h('select', { style: { width: 'auto' } }, h('option', { value: '' }, 'New product…'), products.map(p => h('option', { value: p.id }, `Replace the file of "${p.name}"`)));
    const nameIn = h('input', { placeholder: 'Product name', value: r.plugin?.name || '', style: { width: '170px' } });
    sel.addEventListener('change', () => { nameIn.hidden = !!sel.value; });
    card.append(h('div', { class: 'integ ok' }, h('b', null, `Built ${j.jar.name}`), h('span', null, `${(j.jar.size / 1024).toFixed(0)} KB${j.jar.plugin?.main ? ' · main ' + j.jar.plugin.main : ' · no plugin.yml in this jar'}`)));
    actions.append(h('a', { class: 'btn primary', href: `/api/admin/builds/${j.id}/jar` }, '⬇ Download jar'), sel, nameIn,
      h('button', { class: 'btn', onclick: () => call('POST', `/api/admin/builds/${j.id}/product`, sel.value ? { productId: Number(sel.value) } : { name: nameIn.value }, 'Saved to Products. Open the Products page to get download links.') }, 'Use as product'));
  }
  if (j.status !== 'building') actions.append(h('button', { class: 'btn ghost danger', onclick: () => call('DELETE', `/api/admin/builds/${j.id}`, null, 'Removed') }, 'Remove'));
  card.append(actions);
  queueMicrotask(() => { const l = document.getElementById('log-' + j.id); if (l) l.scrollTop = l.scrollHeight; });
  return card;
}

// --- plans, usage and billing -----------------------------------------------
const money = p => (p.price_cents ? new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency.toUpperCase(), minimumFractionDigits: p.price_cents % 100 ? 2 : 0 }).format(p.price_cents / 100) + ({ month: ' / month', year: ' / year', once: ' once' }[p.interval] || '') : 'Free');
const cap = n => (n === -1 ? 'unlimited' : n.toLocaleString('en-US'));
const plugins = n => `${cap(n)} plugin${n === 1 ? '' : 's'}`;
const meter = (label, used, max) => {
  const pct = max === -1 ? 0 : Math.min(100, Math.round(used / Math.max(max, 1) * 100));
  return h('div', { class: 'meter' }, h('div', { class: 'row spread' }, h('span', null, label), h('b', null, `${used.toLocaleString('en-US')} of ${cap(max)}`)), h('div', { class: 'bar' + (pct >= 90 ? ' hot' : '') }, h('i', { style: { width: pct + '%' } })));
};
function planCard() {
  const w = WS;
  return h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'row spread wrap' }, h('div', null, h('b', { style: { fontSize: '16px' } }, `${w.plan.name} plan`), ' ', h('span', { class: 'muted' }, money(w.plan))), h('a', { class: 'btn sm', href: '#billing' }, 'Plan & billing')),
    h('div', { class: 'meters' }, meter('Plugins', w.usage.products, w.plan.max_products), meter('Licenses', w.usage.licenses, w.plan.max_licenses)));
}
const untilText = w => {
  const d = w.plan_until ? date(w.plan_until) : '';
  if (w.plan_key === 'free') return 'Free plan';
  if (w.lapsed) return `Ended ${d}. Free plan limits apply.`;
  if (w.plan_source === 'manual') return w.plan_until ? `Granted by the site owner until ${d}` : 'Granted by the site owner, no end date';
  if (w.plan_status === 'canceled') return `Canceled. You keep this plan until ${d}`;
  if (w.plan_status === 'past_due') return `Payment failed. Plan active until ${d}`;
  return w.plan_until ? `Paid through ${d}` : 'Paid once, no end date';
};

async function billingPage() {
  const pricing = await api('GET', '/api/public/pricing');
  const w = WS, paid = new URLSearchParams(location.search).get('paid') === '1';
  const go = async (path, body) => { try { const r = await api('POST', path, body); location.href = r.url; } catch (e) { toast(e.message, true); } };
  const site = pricing.site;
  const contact = p => site.discord_url ? h('a', { class: 'btn sm primary', href: site.discord_url, target: '_blank', rel: 'noopener noreferrer' }, 'Buy on Discord')
    : site.support_email ? h('a', { class: 'btn sm primary', href: `mailto:${site.support_email}?subject=${encodeURIComponent(p.name + ' plan')}` }, 'Contact us to buy') : h('span', { class: 'muted' }, 'Coming soon');

  if (paid && w.plan_key === 'free') {            // the payment webhook can take a few seconds to arrive
    let tries = 0;
    buildTimer = setInterval(async () => { tries++; try { const n = await api('GET', '/api/workspace'); if (n.plan_key !== 'free' || tries > 12) { clearInterval(buildTimer); history.replaceState(null, '', '/dashboard#billing'); WS = n; billingPage(); } } catch { clearInterval(buildTimer); } }, 2000);
  }
  const statusChip = w.lapsed ? ['blocked', 'Ended'] : w.plan_status === 'past_due' ? ['idle', 'Payment failed'] : w.plan_status === 'canceled' ? ['idle', 'Canceled'] : ['active', 'Active'];
  render(head('Billing'),
    paid ? h('div', { class: 'notice ok' }, h('b', null, w.plan_key === 'free' ? 'Payment received. ' : 'Thank you! '), w.plan_key === 'free' ? 'Your plan is being activated, this takes a few seconds…' : `Your ${w.plan.name} plan is active.`) : null,
    h('div', { class: 'card', style: { marginBottom: '16px' } },
      h('div', { class: 'row spread wrap' },
        h('div', null, h('div', { class: 'muted', style: { fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.06em' } }, 'Current plan'),
          h('div', { style: { fontSize: '26px', fontWeight: 700, letterSpacing: '-.02em' } }, w.plan.name, ' ', h('span', { class: 'muted', style: { fontSize: '15px', fontWeight: 500 } }, money(w.plan))),
          h('div', { class: 'muted', style: { marginTop: '4px' } }, untilText(w))),
        h('div', { class: 'row wrap' }, w.plan_key !== 'free' ? h('span', { class: 'chip ' + statusChip[0] }, statusChip[1]) : null,
          w.billing.can_portal ? h('button', { class: 'btn primary', onclick: () => go('/api/billing/portal') }, 'Manage billing') : null)),
      h('div', { class: 'meters' }, meter('Plugins', w.usage.products, w.plan.max_products), meter('Licenses', w.usage.licenses, w.plan.max_licenses))),
    h('h3', { style: { margin: '24px 0 10px' } }, 'Plans'),
    h('div', { class: 'plan-rows' }, pricing.plans.map(p => h('div', { class: 'card plan-row' + (p.key === w.plan.key ? ' current' : '') },
      h('div', null, h('b', null, p.name), p.highlight ? h('span', { class: 'tag', style: { marginLeft: '8px' } }, 'Popular') : null, h('div', { class: 'muted', style: { fontSize: '13px' } }, `${plugins(p.max_products)} · ${cap(p.max_licenses)} licenses`)),
      h('div', { style: { fontWeight: 600 } }, money(p)),
      p.key === w.plan.key ? h('span', { class: 'chip active' }, 'Current')
        : p.price_cents === 0 ? h('span', { class: 'muted', style: { fontSize: '13px' } }, w.billing.can_portal ? 'Cancel in billing' : '')
        : pricing.payments ? h('button', { class: 'btn sm primary', onclick: () => go('/api/billing/checkout', { plan: p.key }) }, p.interval === 'once' ? 'Buy' : 'Choose') : contact(p)))),
    h('p', { class: 'muted', style: { fontSize: '13px', marginTop: '14px' } }, 'If your plan ends, existing licenses keep working. You just cannot add more than the Free plan allows.'));
}

// --- customers (owner) ----------------------------------------------------------
async function customersPage() {
  const [list, plans] = await Promise.all([api('GET', '/api/admin/customers'), api('GET', '/api/admin/plans')]);
  const reload = () => customersPage();
  const call = async (method, path, body, msg) => { try { await api(method, path, body); if (msg) toast(msg); reload(); } catch (e) { toast(e.message, true); } };
  const rows = list.filter(c => !c.house);
  const statusOf = c => c.suspended ? ['blocked', 'Suspended'] : c.lapsed ? ['idle', 'Lapsed'] : c.plan_status === 'past_due' ? ['idle', 'Past due'] : c.plan_status === 'canceled' ? ['idle', 'Canceled'] : ['active', 'Active'];

  const invite = () => {
    const dlg = h('dialog', null, h('h3', { style: { marginBottom: '4px' } }, 'Invite a customer'),
      h('p', { class: 'muted', style: { marginTop: 0, fontSize: '14px' } }, 'Creates their account now. They sign in with this email (Google, Discord or GitHub, verified) and it is theirs. Works even when signups are closed.'),
      h('div', { class: 'field' }, h('label', null, 'Email'), h('input', { id: 'i-email', type: 'email', placeholder: 'dev@example.com' })),
      h('div', { class: 'field' }, h('label', null, 'Name (optional)'), h('input', { id: 'i-name' })),
      h('div', { class: 'field' }, h('label', null, 'Plan'), h('select', { id: 'i-plan' }, plans.map(p => h('option', { value: p.key }, `${p.name} · ${money(p)}`)))),
      h('div', { class: 'row', style: { 'justify-content': 'flex-end', marginTop: '14px' } }, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => { await call('POST', '/api/admin/customers', { email: dlg.querySelector('#i-email').value, name: dlg.querySelector('#i-name').value, plan_key: dlg.querySelector('#i-plan').value, until: null }, 'Customer created'); dlg.close(); } }, 'Create')));
    dlg.addEventListener('close', () => dlg.remove()); document.body.append(dlg); dlg.showModal();
  };
  const grant = c => {
    const dlg = h('dialog', null, h('h3', { style: { marginBottom: '4px' } }, 'Give a plan'), h('p', { class: 'muted', style: { marginTop: 0, fontSize: '14px' } }, c.owner_email),
      h('div', { class: 'field' }, h('label', null, 'Plan'), h('select', { id: 'g-plan' }, plans.map(p => h('option', { value: p.key, selected: p.key === c.plan_key }, `${p.name}${p.active ? '' : ' (hidden)'} · ${money(p)}`)))),
      h('div', { class: 'field' }, h('label', { class: 'trustbox' }, h('input', { type: 'checkbox', id: 'g-forever', checked: !c.plan_until }), 'No end date')),
      h('div', { class: 'field', id: 'g-until-box', hidden: !c.plan_until }, h('label', null, 'Until'), h('input', { type: 'date', id: 'g-until', value: new Date((c.plan_until || Date.now() / 1000 + 30 * 86400) * 1000).toISOString().slice(0, 10) })),
      h('div', { class: 'hint' }, 'A hand-given plan is never changed by Stripe events. Choosing Free ends it.'),
      h('div', { class: 'row', style: { 'justify-content': 'flex-end', marginTop: '14px' } }, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const forever = dlg.querySelector('#g-forever').checked, d = dlg.querySelector('#g-until').value;
          await call('POST', `/api/admin/customers/${c.id}/plan`, { plan_key: dlg.querySelector('#g-plan').value, until: forever || !d ? null : Math.floor(new Date(d + 'T23:59:59Z') / 1000) }, 'Plan updated'); dlg.close();
        } }, 'Save')));
    dlg.querySelector('#g-forever').addEventListener('change', e => { dlg.querySelector('#g-until-box').hidden = e.target.checked; });
    dlg.addEventListener('close', () => dlg.remove()); document.body.append(dlg); dlg.showModal();
  };

  render(head('Customers', h('button', { class: 'btn primary', onclick: invite }, '+ Invite customer')),
    h('p', { class: 'muted', style: { marginTop: '-12px' } }, 'Everyone who signed up for a workspace. "Open" lets you look at their account the way they see it.'),
    h('div', { class: 'card table-card' }, h('table', null,
      h('thead', null, h('tr', null, ['Customer', 'Plan', 'Status', 'Plugins', 'Licenses', 'Joined', ''].map(t => h('th', null, t)))),
      h('tbody', null, rows.length ? rows.map(c => h('tr', null,
        h('td', null, h('b', null, c.name), h('div', { class: 'muted keycell' }, c.owner_email)),
        h('td', null, h('b', null, c.plan.name), h('div', { class: 'faint', style: { fontSize: '12px' } }, c.plan_source === 'manual' ? 'given by you' : c.plan_source === 'stripe' ? 'Stripe' : '')),
        h('td', null, h('span', { class: 'chip ' + statusOf(c)[0] }, statusOf(c)[1])),
        h('td', { class: 'muted' }, `${c.products} / ${cap(c.plan.max_products)}`), h('td', { class: 'muted' }, `${c.licenses} / ${cap(c.plan.max_licenses)}`), h('td', { class: 'muted' }, date(c.created_at)),
        h('td', null, h('div', { class: 'row', style: { 'justify-content': 'flex-end', flexWrap: 'wrap' } },
          h('button', { class: 'btn sm', onclick: () => { setWs(c.id); location.hash = 'overview'; location.reload(); } }, 'Open'),
          h('button', { class: 'btn sm', onclick: () => grant(c) }, 'Plan'),
          c.suspended ? h('button', { class: 'btn sm', onclick: () => call('POST', `/api/admin/customers/${c.id}/suspend`, { suspended: false }, 'Unsuspended') }, 'Unsuspend')
            : h('button', { class: 'btn sm danger', onclick: () => { const r = prompt('Reason (shown to their buyers\' plugins):', 'Terms violation'); if (r !== null) call('POST', `/api/admin/customers/${c.id}/suspend`, { suspended: true, reason: r }, 'Suspended'); } }, 'Suspend'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete this customer?', `${c.owner_email}: all of their licenses, products, files and servers are removed permanently, and their buyers' plugins stop working. This does not cancel a Stripe subscription.`, 'Delete everything')) call('DELETE', `/api/admin/customers/${c.id}`, null, 'Deleted'); } }, 'Delete'))))) : h('tr', null, h('td', { colspan: 7, class: 'muted' }, 'No customers yet. They appear here when someone signs up from the pricing page.'))))));
}

// --- plans (owner) ----------------------------------------------------------------
async function plansPage() {
  const [plans, s] = await Promise.all([api('GET', '/api/admin/plans'), api('GET', '/api/admin/settings')]);
  const st = s.stripe || {};
  const edit = p => {
    const isNew = !p, f = id => dlg.querySelector('#' + id);
    const dlg = h('dialog', { style: { width: 'min(560px, calc(100vw - 32px))' } }, h('h3', { style: { marginBottom: '14px' } }, isNew ? 'New plan' : `Edit ${p.name}`),
      isNew ? h('div', { class: 'field' }, h('label', null, 'Key (permanent, used internally)'), h('input', { id: 'p-key', placeholder: 'team' })) : null,
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', null, 'Name'), h('input', { id: 'p-name', value: p?.name || '' })),
        h('div', { class: 'field' }, h('label', null, 'Billing'), h('select', { id: 'p-interval', disabled: p?.key === 'free' }, [['free', 'Free'], ['month', 'Monthly'], ['year', 'Yearly'], ['once', 'One-time']].map(([v, l]) => h('option', { value: v, selected: (p?.interval || 'month') === v }, l))))),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', null, 'Price'), h('input', { id: 'p-price', type: 'number', min: 0, step: '0.01', value: p ? (p.price_cents / 100).toString() : '9', disabled: p?.key === 'free' })),
        h('div', { class: 'field' }, h('label', null, 'Currency'), h('input', { id: 'p-cur', value: p?.currency || 'usd', maxlength: 3 }))),
      h('div', { class: 'field' }, h('label', null, 'Short description'), h('input', { id: 'p-desc', value: p?.description || '' })),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', null, 'Plugins allowed'), h('input', { id: 'p-prod', type: 'number', min: -1, value: p?.max_products ?? 5 }), h('div', { class: 'hint' }, '-1 = unlimited')),
        h('div', { class: 'field' }, h('label', null, 'Licenses allowed'), h('input', { id: 'p-lic', type: 'number', min: -1, value: p?.max_licenses ?? 1000 }))),
      h('div', { class: 'field' }, h('label', null, 'Feature bullets (one per line)'), h('textarea', { id: 'p-feat', rows: 5 }, p?.features || '')),
      h('div', { class: 'row wrap' },
        h('label', { class: 'trustbox' }, h('input', { type: 'checkbox', id: 'p-hot', checked: !!p?.highlight }), 'Mark as "Most popular"'),
        p?.key === 'free' ? null : h('label', { class: 'trustbox' }, h('input', { type: 'checkbox', id: 'p-active', checked: p ? !!p.active : true }), 'For sale (shown on the pricing page)')),
      h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', null, 'Sort order'), h('input', { id: 'p-sort', type: 'number', min: 0, value: p?.sort ?? plans.length, style: { width: '110px' } })),
      h('div', { class: 'row', style: { 'justify-content': 'flex-end', marginTop: '10px' } }, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const body = { name: f('p-name').value, description: f('p-desc').value, interval: f('p-interval').value, price_cents: Math.round(Number(f('p-price').value) * 100), currency: f('p-cur').value,
            max_products: Number(f('p-prod').value), max_licenses: Number(f('p-lic').value), features: f('p-feat').value, highlight: f('p-hot').checked, active: f('p-active') ? f('p-active').checked : true, sort: Number(f('p-sort').value) };
          try { isNew ? await api('POST', '/api/admin/plans', { ...body, key: f('p-key').value }) : await api('PATCH', `/api/admin/plans/${p.key}`, body); dlg.close(); toast('Saved'); plansPage(); } catch (e) { toast(e.message, true); }
        } }, 'Save')));
    dlg.addEventListener('close', () => dlg.remove()); document.body.append(dlg); dlg.showModal();
  };
  render(head('Plans', h('button', { class: 'btn primary', onclick: () => edit(null) }, '+ New plan')),
    h('div', { class: 'card', style: { marginBottom: '16px' } },
      h('div', { class: 'row spread wrap' }, h('h3', null, 'Card payments (Stripe)'), h('span', { class: 'chip ' + (st.configured && st.webhook_configured ? 'active' : st.configured ? 'idle' : 'blocked') }, st.configured && st.webhook_configured ? 'Ready' : st.configured ? 'Add the webhook secret' : 'Not set up')),
      h('p', { class: 'muted', style: { fontSize: '14px', margin: '6px 0 12px' } }, st.configured ? 'Customers can buy from the pricing page. Plans you give by hand under Customers work either way.' : 'Without Stripe, the pricing page shows a contact button instead of Buy, and you give plans by hand under Customers. Setup steps: docs/BILLING.md'),
      h('label', null, 'Webhook address to enter in Stripe'), h('div', { class: 'url-row' }, h('input', { class: 'mono', readonly: true, value: st.webhook_url || '', onclick: e => e.target.select() }), h('button', { class: 'btn sm', onclick: () => copy(st.webhook_url) }, 'Copy')),
      h('div', { class: 'hint' }, 'Events to send: checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed.')),
    h('div', { class: 'card table-card' }, h('table', null,
      h('thead', null, h('tr', null, ['Plan', 'Price', 'Plugins', 'Licenses', 'Customers', ''].map(t => h('th', null, t)))),
      h('tbody', null, plans.map(p => h('tr', null,
        h('td', null, h('b', null, p.name), ' ', h('span', { class: 'faint keycell' }, p.key), p.highlight ? h('span', { class: 'tag', style: { marginLeft: '8px' } }, 'Popular') : null, !p.active ? h('span', { class: 'chip idle', style: { marginLeft: '8px' } }, 'Hidden') : null),
        h('td', null, money(p)), h('td', { class: 'muted' }, cap(p.max_products)), h('td', { class: 'muted' }, cap(p.max_licenses)), h('td', { class: 'muted' }, p.customers),
        h('td', null, h('div', { class: 'row', style: { 'justify-content': 'flex-end' } }, h('button', { class: 'btn sm', onclick: () => edit(p) }, 'Edit'),
          p.key === 'free' ? null : h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete this plan?', `"${p.name}" is removed. Plans customers are on cannot be deleted: hide them instead.`, 'Delete')) { try { await api('DELETE', `/api/admin/plans/${p.key}`); toast('Deleted'); plansPage(); } catch (e) { toast(e.message, true); } } } }, 'Delete')))))))));
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
  render(head('Groups', h('button', { class: 'btn primary', onclick: () => edit(null) }, '+ New group')),
    h('p', { class: 'muted', style: { marginTop: '-12px' } }, 'Groups set a shared server limit. A limit set directly on a license always wins.'),
    h('div', { class: 'card table-card' }, h('table', null, h('thead', null, h('tr', null, ['Group', 'Server limit', 'Licenses', ''].map(t => h('th', null, t)))),
      h('tbody', null, groups.length ? groups.map(g => h('tr', null, h('td', null, h('span', { class: 'tag', style: { '--c': g.color } }, g.name)), h('td', null, limitText(g.max_servers)), h('td', { class: 'muted' }, g.licenses),
        h('td', null, h('div', { class: 'row', style: { 'justify-content': 'flex-end' } }, h('button', { class: 'btn sm', onclick: () => edit(g) }, 'Edit'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Delete group?', `Licenses in "${g.name}" fall back to the default limit.`, 'Delete')) { await api('DELETE', `/api/admin/groups/${g.id}`); groupsPage(); } } }, 'Delete'))))) : h('tr', null, h('td', { colspan: 4, class: 'muted' }, 'No groups yet'))))));
}

// --- settings --------------------------------------------------------------
async function settings() {
  const s = await api('GET', '/api/admin/settings');
  const save = async patch => { try { await api('PUT', '/api/admin/settings', patch); toast('Saved'); return true; } catch (e) { toast(e.message, true); return false; } };
  const toggle = (k, title, desc) => h('label', { class: 'switch', style: { color: 'inherit', fontSize: '15px', margin: 0 } }, h('span', null, h('b', null, title), h('div', { class: 'muted', style: { fontSize: '13px' } }, desc)),
    h('input', { type: 'checkbox', checked: s[k] === '1', onchange: e => save({ [k]: e.target.checked }) }));
  const num = (k, title, desc, min) => h('div', { class: 'switch' }, h('span', null, h('b', null, title), h('div', { class: 'muted', style: { fontSize: '13px' } }, desc)),
    h('input', { type: 'number', min, value: s[k], style: { width: '100px' }, onchange: e => save({ [k]: Number(e.target.value) }) }));

  const text = (k, label, ph, hint) => h('div', { class: 'field' }, h('label', null, label), h('input', { id: 's-' + k, value: s[k] || '', placeholder: ph }), hint && h('div', { class: 'hint' }, hint));
  const brand = h('div', { class: 'card', style: { maxWidth: '680px', marginBottom: '16px' } },
    h('h3', { style: { marginBottom: '4px' } }, 'Website & contact links'),
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '14px' } }, 'Shown on the public license page. Leave a field empty to hide it.'),
    text('site_name', 'Site name', 'LicenseX'),
    text('site_tagline', 'Tagline', 'Licenses for our Minecraft plugins'),
    text('discord_url', 'Discord invite link', 'https://discord.gg/yourinvite'),
    text('store_url', 'BuiltByBit page link', 'https://builtbybit.com/creators/yourname.12345/'),
    text('website_url', 'Website link', 'https://example.com'),
    text('support_email', 'Support email', 'support@example.com'),
    h('button', { class: 'btn primary', onclick: () => save(Object.fromEntries(['site_name', 'site_tagline', 'discord_url', 'store_url', 'website_url', 'support_email'].map(k => [k, brand.querySelector('#s-' + k).value]))) }, 'Save links'));

  const secretEl = h('input', { class: 'mono', readonly: true, value: s.bbb_secret, onclick: e => e.target.select() });
  const urlEl = h('input', { class: 'mono', readonly: true, value: s.bbb_callback_url, onclick: e => e.target.select() });
  const bbb = h('div', { class: 'card', style: { maxWidth: '680px', marginBottom: '16px' } },
    h('h3', { style: { marginBottom: '4px' } }, 'BuiltByBit integration'),
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '14px' } }, 'Create a placeholder on BuiltByBit with type "External license key" using these two values. Each buyer then gets their own license automatically, the same one every time they download. Step-by-step guide: docs/BUILTBYBIT.md in the project.'),
    h('div', { class: 'field' }, h('label', null, 'URL (paste into the placeholder)'), h('div', { class: 'url-row' }, urlEl, h('button', { class: 'btn sm', onclick: () => copy(urlEl.value) }, 'Copy'))),
    h('div', { class: 'field' }, h('label', null, 'Secret'), h('div', { class: 'url-row' }, secretEl, h('button', { class: 'btn sm', onclick: () => copy(secretEl.value) }, 'Copy'),
      h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Generate a new secret?', 'BuiltByBit will be refused until you paste the new secret into your placeholder.', 'Generate', false)) { if (await save({ regenerate_bbb_secret: true })) settings(); } } }, 'New secret'))),
    h('div', { class: 'field' }, h('label', null, 'Group for BuiltByBit buyers'), (() => { const g = groupSelect(Number(s.bbb_group_id) || null); g.id = 's-bbb-group'; g.addEventListener('change', () => save({ bbb_group_id: g.value || '' })); return g; })(),
      h('div', { class: 'hint' }, 'Buyers get this group\'s server limit. No group = the default limit below.')));

  const restoreInput = h('input', { type: 'file', accept: '.zip', hidden: true, onchange: async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (!await confirmDialog('Restore this backup?', `Everything currently in LicenseX (licenses, servers, groups, settings, plugin files) is replaced with the contents of ${file.name}.`, 'Restore')) return;
    try {
      const r = await fetch('/api/admin/restore', { method: 'POST', headers: wsHeaders(), body: file });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Restore failed');
      toast('Backup restored'); settings();
    } catch (err) { toast(err.message, true); }
  } });
  const backup = h('div', { class: 'card', style: { maxWidth: '680px', marginBottom: '16px' } },
    h('h3', { style: { marginBottom: '4px' } }, 'Backup & move'),
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '14px' } }, 'Download everything as one file, and restore it on any LicenseX. Do this before changing host, and regularly if your host can wipe its disk. The file contains every license key, so keep it private.'),
    h('div', { class: 'row wrap' }, h('a', { class: 'btn primary', href: '/api/admin/backup', download: '' }, '⬇ Download backup'),
      h('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Restore from backup'), restoreInput));

  const emailsBox = h('textarea', { id: 's-admin-emails', rows: 4, placeholder: 'you@example.com\nteammate@example.com', style: { fontFamily: 'var(--mono)', fontSize: '13px' } }, (s.admin_emails || []).join('\n'));
  const access = h('div', { class: 'card', style: { maxWidth: '680px', marginBottom: '16px' } },
    h('h3', { style: { marginBottom: '4px' } }, 'Sign-in & admin access'),
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '14px' } }, 'Visitors can sign in with Google, Discord or GitHub. Anyone whose verified email is on this list gets an Admin button in the site header and can open this panel.'),
    h('div', { class: 'field' }, h('label', null, 'Admin emails (one per line)'), emailsBox,
      h('div', { class: 'hint' }, 'Takes effect immediately, and removing an address cuts access on its very next click. Only emails the provider has verified count.')),
    (s.admin_emails_config || []).length ? h('div', { class: 'field' }, h('label', null, 'Always admins (set in the server config, cannot be removed here)'),
      h('div', { class: 'row wrap' }, s.admin_emails_config.map(e => h('span', { class: 'tag' }, e)))) : null,
    h('button', { class: 'btn primary', onclick: () => save({ admin_emails: emailsBox.value }) }, 'Save admins'),
    h('div', { class: 'divider' }, 'Sign-in providers'),
    ...Object.entries(s.oauth || {}).map(([id, p]) => h('div', { class: 'field' },
      h('div', { class: 'row spread', style: { marginBottom: '6px' } }, h('b', null, p.label), h('span', { class: 'chip ' + (p.configured ? 'active' : 'idle') }, p.configured ? 'Ready' : 'Not set up')),
      h('label', null, 'Redirect / callback URL to give ' + p.label),
      h('div', { class: 'url-row' }, h('input', { class: 'mono', readonly: true, value: p.callback_url, onclick: e => e.target.select() }), h('button', { class: 'btn sm', onclick: () => copy(p.callback_url) }, 'Copy')),
      !p.configured && h('div', { class: 'hint' }, `Create the app, then set LICENSEX_${id.toUpperCase()}_CLIENT_ID and LICENSEX_${id.toUpperCase()}_CLIENT_SECRET (or the config file). Steps: docs/LOGIN.md`))),
    s.password_login === false ? h('div', { class: 'hint' }, 'Password login is turned off in the server config.') : h('div', { class: 'hint' }, 'The admin password still works as a backup way in.'));

  const site = window.__me.role === 'platform' && WS.house;   // site-wide cards are the owner's, in the owner's own workspace
  render(head('Settings'), site ? h('div', { class: 'notice ok' }, 'Site-wide settings (branding, sign-in, backups) are below the workspace settings. Customers only see the workspace settings.') : null, site ? access : null, bbb, site ? brand : null, site ? backup : null, h('div', { class: 'card', style: { maxWidth: '680px' } },
    num('default_limit', 'Default server limit', 'Applies to licenses with no group and no override. -1 = unlimited.', -1),
    num('heartbeat_minutes', 'Plugin check-in interval (minutes)', 'How often running plugins re-validate. Removals and blocks take effect within this window.', 1),
    toggle('claims_enabled', 'Issue licenses on download', 'When off, new downloads cannot claim a license (existing licenses keep working).'),
    toggle('public_removal', 'Let owners remove servers', 'Owners can free a slot from the public license page.')));
}

// --- audit -----------------------------------------------------------------
async function audit() {
  const rows = await api('GET', '/api/admin/audit?limit=200');
  render(head('Audit log'), h('div', { class: 'card table-card' }, h('table', null, h('thead', null, h('tr', null, ['When', 'Actor', 'Action', 'Target', 'Detail'].map(t => h('th', null, t)))),
    h('tbody', null, rows.map(a => h('tr', null, h('td', { class: 'muted' }, new Date(a.at * 1000).toLocaleString()), h('td', null, a.actor), h('td', null, h('b', null, a.action)), h('td', { class: 'keycell' }, a.target), h('td', { class: 'muted' }, a.detail)))))));
}

boot();
