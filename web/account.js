import { h, api, toast, confirmDialog, ago, date, limitText, copy } from '/lib.js';

// The buyer portal: every license linked to this account (by key) or issued to its verified email, and the servers on each.
const $ = id => document.getElementById(id);
const listEl = $('list'), form = $('addForm'), keyEl = $('key'), addErr = $('addErr'), addBtn = $('addBtn');
const STATE = { active: 'Active', blocked: 'Blocked', expired: 'Expired' };
let licenses = [], flashId = null;

const svg = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); return s; };
const KEY_ICON = 'M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM11 12l9-9m-3 3l3 3';
const ALERT_ICON = 'M12 9v4m0 4h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z';

// --- list ----------------------------------------------------------------------------------------
function serverRow(l, s) {
  return h('div', { class: 'srv' },
    h('div', null,
      h('div', { class: 'row wrap' }, h('b', null, s.name || 'Unnamed server'), s.status === 'disabled' && h('span', { class: 'chip disabled' }, 'Disabled by admin')),
      h('div', { class: 'meta' }, h('span', { class: 'mono' }, `${s.ip}${s.port ? ':' + s.port : ''}`), ` · ${s.version || 'unknown version'} · last seen ${ago(s.last_seen)}`)),
    l.public_removal && s.status !== 'disabled' && h('button', { class: 'btn danger sm', onclick: () => removeServer(l, s) }, 'Remove'));
}

function licenseCard(l) {
  const full = l.limit !== -1 && l.used >= l.limit, pct = l.limit === -1 ? 0 : Math.min(100, Math.round(l.used / Math.max(l.limit, 1) * 100));
  const sub = [l.developer && `by ${l.developer}`, l.owner && `licensed to ${l.owner}`, `issued ${date(l.created_at)}`, l.expires_at && `expires ${date(l.expires_at)}`].filter(Boolean).join(' · ');
  return h('article', { class: 'card lic' + (l.id === flashId ? ' flash' : ''), 'data-license': l.id },
    h('div', { class: 'lic-head' },
      h('div', null, h('div', { class: 'lic-title' }, l.product || 'Plugin license'), h('div', { class: 'lic-sub' }, sub)),
      h('div', { class: 'row wrap' },
        l.group && h('span', { class: 'tag', style: { '--c': l.group.color } }, l.group.name),
        l.via === 'email' && h('span', { class: 'tag', title: 'The developer issued this license to your email address' }, 'Issued to your email'),
        h('span', { class: 'chip ' + l.state }, STATE[l.state] || l.state),
        l.via === 'key' && h('button', { class: 'btn ghost sm', onclick: () => unlink(l) }, 'Unlink'))),
    l.block_reason && h('div', { class: 'notice bad' }, l.block_reason),
    h('div', { class: 'keybox' }, h('code', null, l.key), h('button', { class: 'btn sm', onclick: () => copy(l.key) }, 'Copy')),
    h('div', { class: 'usage' },
      h('div', null, h('b', null, `${l.used} of ${limitText(l.limit)}`), ` server${l.limit === 1 ? '' : 's'} in use${l.limit === -1 ? ' (no limit)' : ''}`),
      l.limit !== -1 && h('div', { class: 'track' + (full ? ' full' : '') }, h('i', { style: { width: pct + '%' } }))),
    h('div', { class: 'servers' }, h('h3', null, 'Servers'),
      l.servers.length ? l.servers.map(s => serverRow(l, s)) : h('div', { class: 'none' }, 'No servers yet. Start a server with the plugin installed and it appears here.'),
      !l.public_removal && l.servers.length ? h('div', { class: 'hint', style: { 'margin-top': '10px' } }, 'The developer has switched off self-service removal. Contact them to free up a slot.') : null));
}

function draw() {
  if (!licenses.length) {
    listEl.replaceChildren(h('div', { class: 'card state' }, h('div', { class: 'ico' }, svg(KEY_ICON)), h('h2', null, 'No licenses yet'),
      h('p', null, 'Add a license key above to see its servers here. It is printed in your server console when the plugin starts.'),
      h('p', null, 'If a developer issued a license to the email address you signed in with, it shows up by itself.')));
    return;
  }
  listEl.replaceChildren(...licenses.map(licenseCard));
  flashId = null;
}

function showError(message, retry) {
  listEl.replaceChildren(h('div', { class: 'card state' }, h('div', { class: 'ico', style: { color: 'var(--bad)', background: 'rgba(248,113,113,.12)' } }, svg(ALERT_ICON)),
    h('h2', null, 'Could not load your licenses'), h('p', null, message), retry && h('p', null, h('button', { class: 'btn', onclick: retry }, 'Try again'))));
}

const replace = e => { licenses = licenses.map(l => (l.id === e.id ? e : l)); draw(); };

// --- actions -------------------------------------------------------------------------------------
async function removeServer(l, s) {
  if (!await confirmDialog('Remove this server?', `${s.name || 'This server'} (${s.ip}) will stop working with this license the next time it checks in, and its slot becomes free.`, 'Remove server')) return;
  try { replace(await api('POST', `/api/account/licenses/${l.id}/remove-server`, { serverId: s.id })); toast('Server removed'); }
  catch (e) {
    toast(e.message, true);
    if (e.status === 404 || e.status === 409) load({ quiet: true });   // the list was out of date: show what is true now
  }
}

async function unlink(l) {
  if (!await confirmDialog('Remove this license from your account?', 'Only the link to your account is removed. The license and its servers keep working, and you can add it again with its key.', 'Remove from account', false)) return;
  try { await api('DELETE', `/api/account/licenses/${l.id}`); licenses = licenses.filter(x => x.id !== l.id); draw(); toast('License removed from your account'); }
  catch (e) { toast(e.message, true); load({ quiet: true }); }
}

form.addEventListener('submit', async ev => {
  ev.preventDefault();
  addErr.hidden = true;
  const key = keyEl.value.trim();
  if (!key) return;
  addBtn.disabled = true;
  try {
    const l = await api('POST', '/api/account/licenses', { key });
    const had = licenses.some(x => x.id === l.id);
    licenses = had ? licenses.map(x => (x.id === l.id ? l : x)) : [l, ...licenses];
    flashId = l.id; draw();
    keyEl.value = '';
    toast(had ? 'That license was already in your list' : 'License added');
    listEl.querySelector(`[data-license="${l.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (e) {
    if (e.status === 401) return signedOut();
    addErr.textContent = e.message; addErr.hidden = false; keyEl.focus();
  } finally { addBtn.disabled = false; }
});

// --- page ----------------------------------------------------------------------------------------
/** Not signed in (or the session ran out): back to the buyer sign-in. If the server still sees a user, say so instead of looping. */
async function signedOut() {
  let me = null;
  try { me = await api('GET', '/api/auth/me'); } catch {}
  if (!me || !me.user) return location.replace('/login/buyer');
  showError('Your session could not be verified. Sign out and sign in again.');
}

function header(user, me) {
  const slot = $('authNav');
  const u = me?.user;
  slot.replaceChildren(...[
    h('a', { href: '/', class: 'opt' }, 'Check a key'),
    u?.isAdmin ? h('a', { href: '/admin', class: 'admin' }, 'Admin') : u?.workspace ? h('a', { href: '/dashboard', class: 'admin' }, 'Dashboard') : null,
    h('span', { class: 'me-chip muted', title: user.email || user.provider, style: { 'font-size': '14px', padding: '0 6px' } },
      user.avatar ? h('img', { src: user.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'ph' }, (user.name || '?').charAt(0).toUpperCase()),
      h('span', { class: 'opt' }, user.name)),
    h('button', { class: 'linklike', onclick: async () => { try { await api('POST', '/api/auth/logout'); } catch {} location.href = '/'; } }, 'Sign out')].filter(Boolean));
}

async function load({ quiet } = {}) {
  if (!quiet) listEl.replaceChildren(h('div', { class: 'skel' }, ''), h('div', { class: 'skel' }, ''));
  try {
    const r = await api('GET', '/api/account');
    licenses = r.licenses;
    draw();
    api('GET', '/api/auth/me').catch(() => null).then(me => header(r.user, me));   // the Dashboard/Admin buttons are a bonus; never block the list on them
  } catch (e) {
    if (e.status === 401) return signedOut();
    showError(e.message || 'Something went wrong.', () => load());
  }
}

api('GET', '/api/public/site').then(s => {
  const name = s.site_name || 'LicenseX';
  document.title = `My licenses · ${name}`;
  $('siteName').textContent = name;
  $('mark').textContent = name.trim().charAt(0).toUpperCase() || 'X';
}).catch(() => {});
load();
