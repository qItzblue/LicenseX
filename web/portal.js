import { h, api, toast, confirmDialog, ago, date, limitText } from '/lib.js';

const form = document.getElementById('form'), keyEl = document.getElementById('key'), errEl = document.getElementById('err'), out = document.getElementById('result');
const KEY = 'licensex.key';

async function lookup(key, { silent } = {}) {
  errEl.hidden = true;
  try {
    const v = await api('POST', '/api/public/lookup', { key });
    try { sessionStorage.setItem(KEY, key); } catch {}
    render(v);
  } catch (e) {
    out.hidden = true;
    if (!silent) { errEl.textContent = e.message; errEl.hidden = false; }
  }
}

function render(v) {
  const pct = v.limit === -1 ? 0 : Math.min(100, Math.round(v.used / Math.max(v.limit, 1) * 100));
  const stateLabel = { active: 'Active', blocked: 'Blocked', expired: 'Expired' }[v.state];
  out.replaceChildren(
    h('div', { class: 'card summary' },
      h('div', { class: 'ring', style: { '--p': pct } }, h('div', null, h('span', null, `${v.used}/${limitText(v.limit)}`), h('small', null, 'servers'))),
      h('div', null,
        h('div', { class: 'row wrap' },
          h('span', { class: 'chip ' + v.state }, stateLabel),
          v.group && h('span', { class: 'tag', style: { '--c': v.group.color } }, v.group.name)),
        h('h2', { class: 'keyline', style: { margin: '10px 0 4px' } }, v.key),
        h('div', { class: 'muted' }, v.owner ? `Licensed to ${v.owner} · ` : '', `Issued ${date(v.created_at)}`, v.expires_at ? ` · Expires ${date(v.expires_at)}` : ''),
        v.block_reason && h('div', { class: 'err' }, v.block_reason))),
    h('div', { class: 'card' },
      h('h3', { style: { marginBottom: '6px' } }, 'Servers'),
      v.servers.length
        ? v.servers.map(s => h('div', { class: 'srv' },
            h('div', null,
              h('div', { class: 'row' }, h('b', null, s.name || 'Unnamed server'), s.status === 'disabled' && h('span', { class: 'chip disabled' }, 'Disabled by admin')),
              h('div', { class: 'meta mono' }, `${s.ip}${s.port ? ':' + s.port : ''}`, h('span', { class: 'faint' }, ` · ${s.version || 'unknown version'} · last seen ${ago(s.last_seen)}`))),
            v.public_removal && s.status !== 'disabled' && h('button', { class: 'btn danger sm', onclick: () => remove(v, s) }, 'Remove')))
        : h('div', { class: 'empty' }, 'No servers are using this license yet. Start your server with the plugin installed and it will appear here.'),
      !v.public_removal && h('div', { class: 'hint', style: { marginTop: '12px' } }, 'Self-service removal is currently disabled. Contact support.')));
  out.hidden = false;
}

async function remove(v, s) {
  if (!await confirmDialog('Remove this server?', `${s.name || 'This server'} (${s.ip}) will stop working with this license the next time it checks in, and its slot becomes free.`, 'Remove server')) return;
  try { render(await api('POST', '/api/public/remove', { key: v.key, serverId: s.id })); toast('Server removed'); }
  catch (e) { toast(e.message, true); }
}

form.addEventListener('submit', e => { e.preventDefault(); lookup(keyEl.value.trim()); });
const linked = new URLSearchParams(location.search).get('key');
if (linked) { keyEl.value = linked; lookup(linked.trim()); history.replaceState(null, '', location.pathname); }
else try { const k = sessionStorage.getItem(KEY); if (k) { keyEl.value = k; lookup(k, { silent: true }); } } catch {}

// --- site branding + contact links (set by the admin under Settings) -----------------
const ICONS = {
  discord: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  store: 'M4 7h16l-1.2 12.2a1 1 0 0 1-1 .8H6.2a1 1 0 0 1-1-.8L4 7zM8 7a4 4 0 0 1 8 0',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  web: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
};
const icon = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); return s; };
const safeUrl = u => { try { return /^https?:$/.test(new URL(u).protocol) ? u : ''; } catch { return ''; } };

(async function loadSite() {
  let site;
  try { site = await api('GET', '/api/public/site'); } catch { return; }
  const name = site.site_name || 'LicenseX';
  document.title = `${name} · Manage your license`;
  document.getElementById('siteName').textContent = name;
  document.getElementById('mark').textContent = name.trim().charAt(0).toUpperCase() || 'X';
  if (site.site_tagline) document.getElementById('tagline').textContent = site.site_tagline;

  const discord = safeUrl(site.discord_url), store = safeUrl(site.store_url), web = safeUrl(site.website_url), mail = site.support_email;
  const ext = { target: '_blank', rel: 'noopener noreferrer' };
  const nav = document.getElementById('topnav');
  if (store) nav.append(h('a', { href: store, class: 'opt', ...ext }, 'BuiltByBit'));
  if (discord) nav.append(h('a', { href: discord, class: 'pill', ...ext }, 'Join our Discord'));

  const cards = [];
  if (discord) cards.push(['discord', 'Discord', 'Chat with us and the community', discord, ext]);
  if (store) cards.push(['store', 'BuiltByBit', 'Browse our plugins', store, ext]);
  if (mail) cards.push(['mail', 'Email', mail, 'mailto:' + mail, {}]);
  if (web) cards.push(['web', 'Website', web.replace(/^https?:\/\//, '').replace(/\/$/, ''), web, ext]);
  if (cards.length) {
    document.getElementById('contactCards').replaceChildren(...cards.map(([ic, title, sub, href, attrs]) =>
      h('a', { class: 'card cc', href, ...attrs }, h('div', { class: 'ico' }, icon(ICONS[ic])), h('b', null, title), h('span', null, sub))));
    document.getElementById('contact').hidden = false;
    nav.append(h('a', { href: '#contact', class: 'opt' }, 'Contact'));
  }
  const foot = document.getElementById('footLinks');
  foot.replaceChildren(...[[discord, 'Discord'], [store, 'BuiltByBit'], [web, 'Website'], [mail && 'mailto:' + mail, 'Contact'], ['/admin', 'Admin']].filter(([u]) => u).map(([u, t]) => h('a', { href: u, ...(u.startsWith('mailto') || u === '/admin' ? {} : ext) }, t)));
  document.getElementById('footText').textContent = `© ${new Date().getFullYear()} ${name} · Servers are identified by plugin instance, never by your personal data.`;
})();

// --- sign in / account chip / Admin button (top right) ---------------------------------
(async function loadAuth() {
  const slot = document.getElementById('authNav');
  let me;
  try { me = await api('GET', '/api/auth/me'); } catch { return; }
  if (!me.user) {
    if (me.providers.length) slot.append(h('a', { href: '/login', class: 'pill' }, 'Sign in'));
    return;
  }
  const u = me.user;
  slot.append(...[
    u.isAdmin && h('a', { href: '/admin', class: 'admin' }, 'Admin'),
    h('span', { class: 'me-chip muted', title: u.email || u.provider, style: { fontSize: '14px', padding: '0 6px' } },
      u.avatar ? h('img', { src: u.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'ph' }, (u.name || '?').charAt(0).toUpperCase()),
      h('span', { class: 'opt' }, u.name)),
    h('button', { class: 'linklike', onclick: async () => { await api('POST', '/api/auth/logout'); location.reload(); } }, 'Sign out')].filter(Boolean));
})();
