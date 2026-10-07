import { h, api } from '/lib.js';

const card = document.getElementById('card');
const params = new URLSearchParams(location.search);
const next = ['/', '/admin'].includes(params.get('next')) ? params.get('next') : '/';
const ERRORS = {
  denied: 'Sign-in was cancelled.',
  state: 'That sign-in link expired or was already used. Please try again.',
  failed: 'The provider did not complete the sign-in. Please try again.',
  notconfigured: 'That sign-in method is not set up yet.',
};
const brand = () => h('span', { class: 'brand' }, h('span', { class: 'brand-mark', id: 'mark' }, 'X'), h('span', { id: 'siteName' }, 'LicenseX'));
const initial = name => (name || '?').trim().charAt(0).toUpperCase();

async function render() {
  let me;
  try { me = await api('GET', '/api/auth/me'); } catch { card.replaceChildren(h('div', { class: 'err' }, 'Could not reach the server.')); return; }
  try { const s = await api('GET', '/api/public/site'); if (s.site_name) document.title = `Sign in · ${s.site_name}`; } catch {}

  const err = ERRORS[params.get('error')];
  if (me.user) {
    const u = me.user;
    card.replaceChildren(...[brand(),
      h('div', { class: 'who' },
        u.avatar ? h('img', { src: u.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph' }, initial(u.name)),
        h('div', null, h('b', null, u.name), h('div', { class: 'muted', style: { fontSize: '13px' } }, u.email || `Signed in with ${u.provider}`))),
      u.isAdmin ? h('a', { class: 'btn primary', href: '/admin', style: { width: '100%', justifyContent: 'center', marginBottom: '10px' } }, 'Open the admin panel') : null,
      !u.isAdmin && u.email ? h('p', { class: 'muted', style: { fontSize: '13px' } }, `${u.email} is not an admin on this site.`) : null,
      !u.isAdmin && !u.email ? h('p', { class: 'muted', style: { fontSize: '13px' } }, `${u.provider} did not share a verified email address, so this account can't be an admin.`) : null,
      h('a', { class: 'btn', href: '/', style: { width: '100%', justifyContent: 'center', marginBottom: '10px' } }, 'Go to my license'),
      h('button', { class: 'btn ghost', style: { width: '100%', justifyContent: 'center' }, onclick: async () => { await api('POST', '/api/auth/logout'); location.href = '/login'; } }, 'Sign out')].filter(Boolean));
    return;
  }

  card.replaceChildren(...[brand(), h('h1', null, 'Sign in'),
    h('p', { class: 'muted', style: { marginTop: 0 } }, next === '/admin' ? 'Sign in to open the admin panel.' : 'Continue with your account.'),
    err && h('div', { class: 'err' }, err),
    me.providers.length
      ? h('div', { class: 'oauth' }, me.providers.map(p => h('a', { class: 'oauth-btn', href: `/auth/${p.id}?next=${encodeURIComponent(next)}` },
          h('span', { class: `logo ${p.id}` }, p.label.charAt(0)), `Continue with ${p.label}`)))
      : h('p', { class: 'muted' }, 'Sign-in is not set up on this site yet. The owner can enable it in the server settings.'),
    next === '/admin' && me.password_login ? h('div', null, h('div', { class: 'divider' }, 'or'), h('a', { class: 'btn', href: '/admin', style: { width: '100%', justifyContent: 'center' } }, 'Use the admin password')) : null].filter(Boolean));
}
render();
