import { h, api } from '/lib.js';

const plansEl = document.getElementById('plans');
const errEl = document.getElementById('err');
const ext = { target: '_blank', rel: 'noopener noreferrer' };
const BUY_KEY = 'lx-buy';
const store = { get: () => { try { return sessionStorage.getItem(BUY_KEY); } catch { return null; } }, set: v => { try { sessionStorage.setItem(BUY_KEY, v); } catch {} }, clear: () => { try { sessionStorage.removeItem(BUY_KEY); } catch {} } };

const money = p => new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency.toUpperCase(), minimumFractionDigits: p.price_cents % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(p.price_cents / 100);
const per = p => ({ month: '/ month', year: '/ year', once: 'one-time payment', free: 'forever' }[p.interval]);
const lim = n => (n === -1 ? 'Unlimited' : n.toLocaleString('en-US'));
const showErr = m => { errEl.textContent = m; errEl.hidden = !m; };

let pricing, me;

function cta(p) {
  const signedIn = !!me.user, current = pricing.current;
  const isCurrent = current && current.plan_key === p.key;
  if (isCurrent) return h('button', { class: 'btn', disabled: true }, p.price_cents ? 'Your current plan' : (me.user?.workspace ? 'Your current plan' : 'Free'));
  if (!pricing.signups && !me.user?.workspace) return h('button', { class: 'btn', disabled: true }, 'Invite only');
  if (p.price_cents === 0)
    return signedIn
      ? h('button', { class: 'btn', onclick: async () => { try { await api('POST', '/api/workspace/ensure'); location.href = '/dashboard'; } catch (e) { showErr(e.message); } } }, me.user.workspace ? 'Open dashboard' : 'Get started free')
      : h('a', { class: 'btn', href: '/login?next=/dashboard' }, 'Get started free');
  if (!pricing.payments) {
    const s = pricing.site, discord = s.discord_url, mail = s.support_email;
    if (discord) return h('a', { class: 'btn primary', href: discord, ...ext }, `Buy ${p.name} on Discord`);
    if (mail) return h('a', { class: 'btn primary', href: `mailto:${mail}?subject=${encodeURIComponent(`${s.site_name || 'LicenseX'} ${p.name} plan`)}` }, `Contact us to buy`);
    return h('button', { class: 'btn', disabled: true }, 'Coming soon');
  }
  return h('button', { class: 'btn primary' + (p.highlight ? '' : ''), onclick: () => buy(p) }, p.interval === 'once' ? `Buy ${p.name}` : `Get ${p.name}`);
}

async function buy(p) {
  showErr('');
  if (!me.user) { store.set(p.key); location.href = '/login?next=/pricing'; return; }
  try { const r = await api('POST', '/api/billing/checkout', { plan: p.key }); location.href = r.url; }
  catch (e) { showErr(e.message); }
}

function planCard(p) {
  return h('div', { class: 'card plan' + (p.highlight ? ' hot' : '') },
    p.highlight && h('span', { class: 'badge' }, 'Most popular'),
    h('h2', null, p.name), h('p', { class: 'desc' }, p.description),
    h('div', { class: 'price' }, h('b', null, p.price_cents ? money(p) : 'Free'), h('span', null, per(p))),
    h('div', { class: 'limits' }, `${lim(p.max_products)} plugin${p.max_products === 1 ? '' : 's'} · ${lim(p.max_licenses)} licenses`),
    h('ul', null, p.features.map(f => h('li', null, f))),
    cta(p));
}

function comparison(plans) {
  const t = document.getElementById('cmp');
  const rows = [['Price', p => (p.price_cents ? `${money(p)} ${per(p)}` : 'Free')], ['Plugins', p => lim(p.max_products)], ['Licenses', p => lim(p.max_licenses)],
    ['Automatic license check', () => '✓'], ['BuiltByBit integration', () => '✓'], ['Server limits and groups', () => '✓'], ['Buyer license portal', () => '✓']];
  t.replaceChildren(h('thead', null, h('tr', null, h('th'), plans.map(p => h('th', null, p.name)))),
    h('tbody', null, rows.map(([label, f]) => h('tr', null, h('td', null, label), plans.map(p => { const v = f(p); return h('td', { class: v === '✓' ? 'tick' : '' }, v); })))));
  document.getElementById('compare').hidden = false;
}

function chrome(site) {
  const name = site.site_name || 'LicenseX';
  document.title = `Pricing · ${name}`;
  document.getElementById('siteName').textContent = name;
  document.getElementById('mark').textContent = name.trim().charAt(0).toUpperCase() || 'X';
  const links = [[site.discord_url, 'Discord'], [site.store_url, 'BuiltByBit'], [site.website_url, 'Website'], [site.support_email && 'mailto:' + site.support_email, 'Contact'], ['/', 'Check a license']].filter(([u]) => u);
  document.getElementById('footLinks').replaceChildren(...links.map(([u, t]) => h('a', { href: u, ...(/^https?:/.test(u) ? ext : {}) }, t)));
  document.getElementById('footText').textContent = `© ${new Date().getFullYear()} ${name}`;
}

function authNav() {
  const slot = document.getElementById('authNav');
  if (!me.user) { if (me.providers.length) slot.append(h('a', { href: '/login?next=/pricing', class: 'pill' }, 'Sign in')); return; }
  const u = me.user;
  slot.append(...[
    u.isAdmin ? h('a', { href: '/admin', class: 'admin' }, 'Admin') : u.workspace ? h('a', { href: '/dashboard', class: 'admin' }, 'Dashboard') : null,
    h('button', { class: 'linklike', onclick: async () => { await api('POST', '/api/auth/logout'); location.reload(); } }, 'Sign out')].filter(Boolean));
}

(async function init() {
  try { [pricing, me] = await Promise.all([api('GET', '/api/public/pricing'), api('GET', '/api/auth/me')]); }
  catch { plansEl.replaceChildren(h('div', { class: 'toast-err', style: { gridColumn: '1/-1' } }, 'Could not load the plans. Please refresh.')); return; }
  chrome(pricing.site); authNav();
  plansEl.replaceChildren(...pricing.plans.map(planCard));
  if (pricing.plans.length > 1) comparison(pricing.plans);
  document.getElementById('payNote').textContent = pricing.payments ? 'Secure checkout by Stripe. Cancel monthly plans any time.' : '';
  const cta2 = document.getElementById('ctaBtn');
  if (!pricing.signups && !(me.user && (me.user.workspace || me.user.isAdmin))) { cta2.removeAttribute('href'); cta2.textContent = 'Invite only'; cta2.classList.remove('primary'); cta2.setAttribute('aria-disabled', 'true'); }
  if (me.user) { cta2.href = '/dashboard'; cta2.textContent = me.user.workspace || me.user.isAdmin ? 'Open dashboard' : 'Get started free'; if (!me.user.workspace && !me.user.isAdmin) cta2.onclick = async e => { e.preventDefault(); try { await api('POST', '/api/workspace/ensure'); location.href = '/dashboard'; } catch (err) { showErr(err.message); } }; }
  // came back from signing in after pressing Buy: carry on to checkout
  const pending = store.get();
  if (pending && me.user) { store.clear(); const p = pricing.plans.find(x => x.key === pending); if (p && p.price_cents && pricing.payments) buy(p); }
})();
