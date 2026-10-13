import { h, api } from '/lib.js';

// One file serves /login (pick who you are), /login/creator and /login/buyer. Everything is built with h(), never innerHTML.
const view = document.getElementById('view'), box = document.getElementById('box');
const params = new URLSearchParams(location.search);
const ERRORS = {
  denied: 'Sign-in was cancelled.',
  state: 'That sign-in link expired or was already used. Please try again.',
  failed: 'The provider did not complete the sign-in. Please try again.',
  notconfigured: 'That sign-in method is not set up yet.',
  expired: 'The sign-in took too long. Please sign in again.',
};
const PATH = location.pathname.replace(/\/+$/, '');
const ALLOWED = { creator: ['/dashboard', '/pricing', '/admin'], buyer: ['/account'] };   // where each kind of sign-in may land (the server checks too)
const asked = params.get('next');
// Old links such as /login?next=/dashboard (or the pricing page's /login?next=/pricing) still go straight to the creator sign-in.
const KIND = PATH === '/login/creator' ? 'creator' : PATH === '/login/buyer' ? 'buyer' : Object.keys(ALLOWED).find(k => ALLOWED[k].includes(asked)) || null;
const nextFor = kind => (ALLOWED[kind].includes(asked) ? asked : kind === 'creator' ? '/dashboard' : '/account');
document.body.dataset.page = KIND || 'chooser';

// The provider sends failures back to /login. Remember which page the visitor came from so the error shows up there.
const FROM = 'lx-login-from';
const remember = (kind, next) => { try { sessionStorage.setItem(FROM, JSON.stringify({ kind, next, at: Date.now() })); } catch {} };
const recalled = () => {
  try { const v = JSON.parse(sessionStorage.getItem(FROM)); sessionStorage.removeItem(FROM); return v && Object.hasOwn(ALLOWED, v.kind) && Date.now() - v.at < 15 * 60e3 ? v : null; } catch { return null; }
};

const svg = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); return s; };
const ICON = {
  creator: 'M21 8l-9-5-9 5v8l9 5 9-5V8zM3.3 7.5L12 12.5l8.7-5M12 21v-8.5',   // a package: what a creator ships
  buyer: 'M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM11 12l9-9m-3 3l3 3',            // a key: what a buyer holds
};
const initial = name => (name || '?').trim().charAt(0).toUpperCase();
let site = 'LicenseX';
const brand = () => h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-mark' }, site.trim().charAt(0).toUpperCase() || 'X'), h('span', null, site));
const wide = on => box.classList.toggle('wide', on);

function providerButtons(me, kind, next) {
  return me.providers.length
    ? h('div', { class: 'oauth' }, me.providers.map(p => h('a', { class: 'oauth-btn', href: `/auth/${p.id}?next=${encodeURIComponent(next)}`, onclick: () => remember(kind, next) },
        h('span', { class: `logo ${p.id}` }, p.label.charAt(0)), `Continue with ${p.label}`)))
    : h('p', { class: 'muted' }, 'Signing in with Google, Discord or GitHub is not switched on for this site yet. The site owner sets it up in the server settings (docs/LOGIN.md).');
}

function chooser(err) {
  wide(true);
  return [
    h('div', { class: 'head' }, brand(), h('h1', null, 'Sign in'), h('p', { class: 'muted', style: { margin: 0 } }, 'Choose how you use ' + site + '.')),
    err && h('div', { class: 'err', style: { 'margin-top': '18px' } }, err),
    h('div', { class: 'choices' },
      h('a', { class: 'card choice', href: '/login/creator', id: 'pickCreator' }, h('span', { class: 'ico' }, svg(ICON.creator)),
        h('h2', null, "I'm a creator"), h('p', null, 'I make Minecraft plugins. Dashboard, products, licenses and team.'), h('span', { class: 'go' }, 'Creator sign in →')),
      h('a', { class: 'card choice', href: '/login/buyer', id: 'pickBuyer' }, h('span', { class: 'ico' }, svg(ICON.buyer)),
        h('h2', null, "I'm a buyer"), h('p', null, 'I bought a plugin. See my licenses and servers.'), h('span', { class: 'go' }, 'Buyer sign in →'))),
    h('p', { class: 'alt' }, 'Only have a license key? ', h('a', { href: '/' }, 'Check it without an account'), '.'),
  ];
}

function creatorCard(me, err) {
  const next = nextFor('creator'), admin = next === '/admin';
  wide(false);
  return h('div', { class: 'card' }, brand(), h('div', null, h('span', { class: 'eyebrow' }, admin ? 'Admin' : 'Creator')),
    h('h1', null, admin ? 'Admin sign in' : 'Creator sign in'),
    h('p', { class: 'muted lead' }, admin ? 'Sign in to open the admin panel.'
      : 'Sell Minecraft plugins with license keys, buyer pages and a team dashboard. New here? Signing in creates your free workspace. No card needed.'),
    err && h('div', { class: 'err' }, err),
    providerButtons(me, 'creator', next),
    // the site owner can always get in with the admin password (also before Google/Discord/GitHub are set up)
    me.password_login && (admin || !me.providers.length) ? h('div', null, h('div', { class: 'divider' }, admin || me.providers.length ? 'or' : 'site owner'), h('a', { class: 'btn block', href: '/admin', id: 'usePassword' }, 'Use the admin password')) : null,
    h('p', { class: 'alt' }, 'Bought a plugin instead? ', h('a', { href: '/login/buyer' }, 'Buyer sign in')));
}

function buyerCard(me, err) {
  wide(false);
  return h('div', { class: 'card' }, brand(), h('div', null, h('span', { class: 'eyebrow' }, 'Buyer')),
    h('h1', null, 'Buyer sign in'),
    h('p', { class: 'muted lead' }, 'Bought a plugin? Sign in to see all your licenses and servers in one place, and free up a server slot whenever you move.'),
    err && h('div', { class: 'err' }, err),
    providerButtons(me, 'buyer', nextFor('buyer')),
    h('div', { class: 'divider' }, 'no account needed'),
    h('a', { class: 'btn block', href: '/', id: 'keyLookup' }, 'Look up a license with its key'),
    h('p', { class: 'alt' }, 'Make plugins yourself? ', h('a', { href: '/login/creator' }, 'Creator sign in')));
}

function signedIn(u, err) {
  wide(false);
  const start = async () => { try { await api('POST', '/api/workspace/ensure'); location.href = '/dashboard'; } catch (e) { alert(e.message); } };
  const lead = u.isAdmin ? 'admin' : u.workspace ? 'dashboard' : 'licenses';
  return h('div', { class: 'card' }, brand(),
    h('div', { class: 'who' },
      u.avatar ? h('img', { src: u.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph' }, initial(u.name)),
      h('div', null, h('div', { class: 'muted', style: { 'font-size': '12px' } }, 'Signed in as'), h('b', null, u.name), h('div', { class: 'muted', style: { 'font-size': '13px' } }, u.email || `Signed in with ${u.provider}`))),
    err && h('div', { class: 'err' }, err),
    u.isAdmin ? h('a', { class: 'btn primary block', href: '/admin' }, 'Open the admin panel') : null,
    u.workspace ? h('a', { class: 'btn block' + (lead === 'dashboard' ? ' primary' : ''), href: '/dashboard' }, 'Open my dashboard') : null,
    h('a', { class: 'btn block' + (lead === 'licenses' ? ' primary' : ''), href: '/account' }, 'My licenses'),
    !u.isAdmin && !u.workspace && u.email ? h('button', { class: 'btn block', onclick: start }, 'Create my free creator workspace') : null,
    h('a', { class: 'btn block', href: '/' }, 'Look up a license key'),
    h('button', { class: 'btn ghost block', onclick: async () => { await api('POST', '/api/auth/logout'); location.href = '/login'; } }, 'Sign out'));
}

/** Second step of a Google/Discord/GitHub sign-in when two-factor is on. */
function codeCard() {
  wide(false);
  const input = h('input', { id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, placeholder: '123456',
    style: { 'font-family': 'var(--mono)', 'font-size': '22px', 'letter-spacing': '.2em', 'text-align': 'center' } });
  const err = h('div', { class: 'err', hidden: true });
  const go = async e => {
    e?.preventDefault();
    try { const r = await api('POST', '/api/auth/2fa', { code: input.value.trim() }); location.replace(r.next || '/'); }
    catch (x) {
      if (x.data?.code === '2FA_EXPIRED') return location.replace('/login?error=expired');
      err.textContent = x.message; err.hidden = false; input.select();
    }
  };
  setTimeout(() => input.focus(), 0);
  return h('div', { class: 'card' }, brand(), h('div', null, h('span', { class: 'eyebrow' }, 'Two-factor')),
    h('h1', null, 'Enter your code'),
    h('p', { class: 'muted lead' }, 'Open your authenticator app and enter the 6-digit code for ' + site + '. Lost your phone? Enter one of your recovery codes.'),
    h('form', { onsubmit: go }, h('div', { class: 'field' }, input), err, h('button', { class: 'btn primary block', id: 'codeGo' }, 'Continue')),
    h('p', { class: 'alt' }, h('a', { href: '/login', onclick: async ev => { ev.preventDefault(); await api('POST', '/api/auth/logout'); location.href = '/login'; } }, 'Cancel and sign in again')));
}

async function render() {
  let me;
  try { me = await api('GET', '/api/auth/me'); } catch { view.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'err' }, 'Could not reach the server.'))); return; }
  const code = params.get('error'), err = ERRORS[code];
  if (PATH === '/login/2fa') {
    if (!me.twofa_pending) return location.replace(me.user ? '/login' : '/login?error=expired');
    try { const s = await api('GET', '/api/public/site'); if (s.site_name) site = s.site_name; } catch {}
    document.title = `Two-factor code · ${site}`;
    return view.replaceChildren(codeCard());
  }
  // Back from a failed provider round trip: show the message on the page the visitor started from.
  if (code && PATH === '/login' && !KIND) {
    const from = recalled();
    if (from) return location.replace(`/login/${from.kind}?error=${encodeURIComponent(code)}&next=${encodeURIComponent(from.next)}`);
  }
  // Already signed in: the two sign-in pages just take you where you were going.
  if (me.user && !code && (PATH === '/login/creator' || PATH === '/login/buyer')) return location.replace(nextFor(KIND));
  try { const s = await api('GET', '/api/public/site'); if (s.site_name) site = s.site_name; } catch {}
  document.title = `${KIND === 'creator' ? 'Creator sign in' : KIND === 'buyer' ? 'Buyer sign in' : 'Sign in'} · ${site}`;

  view.replaceChildren(...[].concat(me.user ? signedIn(me.user, err)
    : KIND === 'creator' ? creatorCard(me, err)
    : KIND === 'buyer' ? buyerCard(me, err)
    : chooser(err)).filter(Boolean));
}
render();
