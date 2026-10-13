import { h, api } from '/lib.js';
import { icon, logo, eyebrow, otp, siteChrome } from '/lx.js';

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

const initial = name => (name || '?').trim().charAt(0).toUpperCase();
let site = 'LicenseX';
const brand = () => logo(site);
const wide = on => box.classList.toggle('wide', on);

function providerButtons(me, kind, next) {
  return me.providers.length
    ? h('div', { class: 'oauth' }, me.providers.map(p => h('a', { class: 'oauth-btn', href: `/auth/${p.id}?next=${encodeURIComponent(next)}`, onclick: () => remember(kind, next) },
        h('span', { class: `logo ${p.id}` }, p.label.charAt(0)), `Continue with ${p.label}`)))
    : h('p', { class: 'muted' }, 'Signing in with Google, Discord or GitHub is not switched on for this site yet. The site owner sets it up in the server settings (docs/LOGIN.md).');
}

function chooser(err) {
  wide(true);
  const card = (id, href, ic, title, text, go) => h('a', { class: 'lx-choice', href, id }, h('span', { class: 'lx-well' }, icon(ic, 22)),
    h('span', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, h('h2', null, title), h('p', null, text)), h('span', { class: 'go' }, go, icon('arrow-right', 16)));
  return [
    h('div', { class: 'head' }, h('span', { style: { color: 'var(--accent)' } }, h('span', { class: 'lx-logo' }, h('span', { class: 'mark', 'aria-hidden': 'true' }))),
      h('h1', null, `Sign in to ${site}`), h('p', { class: 'muted', style: { margin: 0, fontSize: '16px' } }, 'Which account are you signing in to?')),
    err && h('div', { class: 'err' }, err),
    h('div', { class: 'choices' },
      card('pickCreator', '/login/creator', 'package', "I'm a creator", 'I make Minecraft plugins. Dashboard, products, licenses and team.', 'Creator sign in'),
      card('pickBuyer', '/login/buyer', 'key-round', "I'm a buyer", 'I bought a plugin. See my licenses and servers.', 'Buyer sign in')),
    h('p', { class: 'alt' }, 'Only have a license key? ', h('a', { href: '/#check' }, 'Check it without an account'), '.'),
  ];
}

function creatorCard(me, err) {
  const next = nextFor('creator'), admin = next === '/admin';
  wide(false);
  return h('div', { class: 'lx-card' }, brand(), h('div', { style: { marginTop: '22px' } }, eyebrow(admin ? 'Admin' : 'Creator')),
    h('h1', null, admin ? 'Admin sign in' : 'Creator sign in'),
    h('p', { class: 'muted lead' }, admin ? 'Sign in to open the admin panel.'
      : 'Sell Minecraft plugins with license keys, buyer pages and a team dashboard. New here? Signing in creates your free workspace. No card needed.'),
    err && h('div', { class: 'err' }, err),
    providerButtons(me, 'creator', next),
    // the site owner can always get in with the admin password (also before Google/Discord/GitHub are set up)
    me.password_login && (admin || !me.providers.length) ? h('div', null, h('div', { class: 'divider' }, admin || me.providers.length ? 'or' : 'site owner'), h('a', { class: 'lx-btn lg block', href: '/admin', id: 'usePassword' }, 'Use the admin password')) : null,
    h('p', { class: 'alt' }, 'Bought a plugin instead? ', h('a', { href: '/login/buyer' }, 'Buyer sign in')));
}

function buyerCard(me, err) {
  wide(false);
  return h('div', { class: 'lx-card' }, brand(), h('div', { style: { marginTop: '22px' } }, eyebrow('Buyer')),
    h('h1', null, 'Buyer sign in'),
    h('p', { class: 'muted lead' }, 'Bought a plugin? Sign in to see all your licenses and servers in one place, and free up a server slot whenever you move.'),
    err && h('div', { class: 'err' }, err),
    providerButtons(me, 'buyer', nextFor('buyer')),
    h('div', { class: 'divider' }, 'no account needed'),
    h('a', { class: 'lx-btn lg block', href: '/', id: 'keyLookup' }, 'Look up a license with its key'),
    h('p', { class: 'alt' }, 'Make plugins yourself? ', h('a', { href: '/login/creator' }, 'Creator sign in')));
}

function signedIn(u, err) {
  wide(false);
  const start = async () => { try { await api('POST', '/api/workspace/ensure'); location.href = '/dashboard'; } catch (e) { alert(e.message); } };
  const lead = u.isAdmin ? 'admin' : u.workspace ? 'dashboard' : 'licenses';
  return h('div', { class: 'lx-card' }, brand(),
    h('div', { class: 'who' },
      u.avatar ? h('img', { src: u.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph' }, initial(u.name)),
      h('div', null, h('div', { class: 'muted', style: { 'font-size': '12px' } }, 'Signed in as'), h('b', null, u.name), h('div', { class: 'muted', style: { 'font-size': '13px' } }, u.email || `Signed in with ${u.provider}`))),
    err && h('div', { class: 'err' }, err),
    u.isAdmin ? h('a', { class: 'lx-btn primary lg block', href: '/admin' }, 'Open the admin panel') : null,
    u.workspace ? h('a', { class: 'lx-btn lg block' + (lead === 'dashboard' ? ' primary' : ''), href: '/dashboard' }, 'Open my dashboard') : null,
    h('a', { class: 'lx-btn lg block' + (lead === 'licenses' ? ' primary' : ''), href: '/account' }, 'My licenses'),
    !u.isAdmin && !u.workspace && u.email ? h('button', { class: 'lx-btn lg block', onclick: start }, 'Create my free creator workspace') : null,
    h('a', { class: 'lx-btn lg block', href: '/' }, 'Look up a license key'),
    h('button', { class: 'lx-btn ghost lg block', onclick: async () => { await api('POST', '/api/auth/logout'); location.href = '/login'; } }, 'Sign out'));
}

/** Second step of a Google/Discord/GitHub sign-in when two-factor is on. */
function codeCard() {
  wide(false);
  const status = h('span', { class: 'status', role: 'status' }, 'Codes refresh every 30 seconds.');
  let recovery = false, busy = false;
  const send = async code => {
    if (busy) return; busy = true; go.disabled = true; status.className = 'status'; status.textContent = 'Checking…';
    try { const r = await api('POST', '/api/auth/2fa', { code }); status.textContent = "You're in."; location.replace(r.next || '/'); }
    catch (x) {
      if (x.data?.code === '2FA_EXPIRED') return location.replace('/login?error=expired');
      status.className = 'status bad'; status.textContent = x.data?.code === '2FA_WRONG' ? "That code didn't work. Codes refresh every 30 seconds." : x.message;
      if (recovery) rec.select(); else { boxes.bad(true); boxes.clear(); }
    } finally { busy = false; go.disabled = false; }
  };
  const boxes = otp({ id: 'code', onComplete: v => send(v) });
  const rec = h('input', { id: 'recovery', placeholder: 'abcde-12345', autocomplete: 'off', spellcheck: 'false', style: { fontFamily: 'var(--font-mono)', fontSize: '18px', letterSpacing: '.08em', height: '52px' } });
  const area = h('div', { class: 'codebox' }, boxes.el, status);
  const go = h('button', { class: 'lx-btn primary lg block', id: 'codeGo', type: 'submit' }, 'Verify');
  const toggle = h('a', { href: '#', id: 'useRecovery' }, 'Use a recovery code instead');
  toggle.addEventListener('click', e => {
    e.preventDefault(); recovery = !recovery;
    area.replaceChildren(recovery ? rec : boxes.el, status);
    toggle.textContent = recovery ? 'Use the code from your app instead' : 'Use a recovery code instead';
    status.className = 'status'; status.textContent = recovery ? 'Each recovery code works once.' : 'Codes refresh every 30 seconds.';
    (recovery ? rec : boxes).focus();
  });
  const form = h('form', { onsubmit: e => { e.preventDefault(); send(recovery ? rec.value.trim() : boxes.value()); } }, area, go);
  setTimeout(() => boxes.focus(), 0);
  return h('div', { class: 'lx-card' }, brand(), h('div', { style: { marginTop: '22px' } }, eyebrow('Two-factor')),
    h('h1', null, 'Enter your code'),
    h('p', { class: 'lead' }, `Open your authenticator app and enter the 6-digit code for ${site}.`),
    form,
    h('p', { class: 'alt' }, toggle, ' · ', h('a', { href: '/login', onclick: async ev => { ev.preventDefault(); await api('POST', '/api/auth/logout'); location.href = '/login'; } }, 'Cancel')));
}

async function render() {
  try { site = (await siteChrome()).name; } catch {}
  let me;
  try { me = await api('GET', '/api/auth/me'); } catch { view.replaceChildren(h('div', { class: 'lx-card' }, h('div', { class: 'err' }, 'Could not reach the server.'))); return; }
  const code = params.get('error'), err = ERRORS[code];
  if (PATH === '/login/2fa') {
    if (!me.twofa_pending) return location.replace(me.user ? '/login' : '/login?error=expired');
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
  document.title = `${KIND === 'creator' ? 'Creator sign in' : KIND === 'buyer' ? 'Buyer sign in' : 'Sign in'} · ${site}`;

  view.replaceChildren(...[].concat(me.user ? signedIn(me.user, err)
    : KIND === 'creator' ? creatorCard(me, err)
    : KIND === 'buyer' ? buyerCard(me, err)
    : chooser(err)).filter(Boolean));
}
render();
