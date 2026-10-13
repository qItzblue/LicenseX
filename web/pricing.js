import { h, api } from '/lib.js';
import { icon, eyebrow, siteChrome } from '/lx.js';

const plansEl = document.getElementById('plans');
const errEl = document.getElementById('err');
const ext = { target: '_blank', rel: 'noopener noreferrer' };

const money = p => new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency.toUpperCase(), minimumFractionDigits: p.price_cents % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(p.price_cents / 100);
const per = p => ({ month: '/ month', year: '/ year', once: 'one-time payment', free: 'forever' }[p.interval]);
const lim = n => (n === -1 ? 'Unlimited' : n.toLocaleString('en-US'));
const showErr = m => { errEl.textContent = m; errEl.hidden = !m; };

let pricing, me;

function cta(p) {
  const signedIn = !!me.user, current = pricing.current;
  const isCurrent = current && current.plan_key === p.key;
  if (isCurrent) return h('button', { class: 'lx-btn lg block btn', disabled: true }, p.price_cents ? 'Your current plan' : (me.user?.workspace ? 'Your current plan' : 'Free'));
  if (p.price_cents === 0 && !pricing.signups && !me.user?.workspace) return h('button', { class: 'lx-btn lg block btn', disabled: true }, 'Invite only');
  if (p.price_cents === 0)
    return signedIn
      ? h('button', { class: 'lx-btn lg block btn', onclick: async () => { try { await api('POST', '/api/workspace/ensure'); location.href = '/dashboard'; } catch (e) { showErr(e.message); } } }, me.user.workspace ? 'Open dashboard' : 'Get started free')
      : h('a', { class: 'lx-btn lg block btn', href: '/login/creator' }, 'Get started free');
  // Paid plans are bought on BuiltByBit; the buyer then activates the key from the downloaded file in their dashboard.
  if (p.buy_url) return h('a', { class: 'lx-btn lg block btn' + (p.highlight ? ' primary' : ''), href: p.buy_url, ...ext }, p.interval === 'once' ? `Buy ${p.name} on BuiltByBit` : `Get ${p.name} on BuiltByBit`);
  const s = pricing.site, discord = s.discord_url, mail = s.support_email;
  if (discord) return h('a', { class: 'lx-btn lg block btn primary', href: discord, ...ext }, `Buy ${p.name} on Discord`);
  if (mail) return h('a', { class: 'lx-btn lg block btn primary', href: `mailto:${mail}?subject=${encodeURIComponent(`${s.site_name || 'LicenseX'} ${p.name} plan`)}` }, `Contact us to buy`);
  return h('button', { class: 'lx-btn lg block btn', disabled: true }, 'Coming soon');
}

function planCard(p) {
  const el = h('div', { class: 'lx-card lx-plan plan' + (p.highlight ? ' hot' : ' interactive') },
    h('div', { class: 'top' }, h('b', null, p.name), p.highlight ? eyebrow('Most picked') : null),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      h('div', { class: 'price' }, h('b', null, p.price_cents ? money(p) : 'Free'), h('span', null, per(p))),
      p.description ? h('span', { class: 'blurb' }, p.description) : null),
    h('ul', null, [`${lim(p.max_products)} plugin${p.max_products === 1 ? '' : 's'}`, `${lim(p.max_licenses)} licenses`, ...p.features.filter(f => !/^\d[\d,.]* (plugins?|licenses)$/i.test(f))]
      .map(f => h('li', null, icon('check', 16, 2.25), f))),
    cta(p));
  return el;
}

function comparison(plans) {
  const t = document.getElementById('cmp');
  const rows = [['Price', p => (p.price_cents ? `${money(p)} ${per(p)}` : 'Free')], ['Plugins', p => lim(p.max_products)], ['Licenses', p => lim(p.max_licenses)],
    ['Automatic license check', () => '✓'], ['BuiltByBit integration', () => '✓'], ['Server limits and groups', () => '✓'], ['Buyer license portal', () => '✓']];
  t.replaceChildren(h('thead', null, h('tr', null, h('th'), plans.map(p => h('th', null, p.name)))),
    h('tbody', null, rows.map(([label, f]) => h('tr', null, h('td', null, label), plans.map(p => { const v = f(p); return h('td', { class: v === '✓' ? 'tick' : '' }, v); })))));
  document.getElementById('compare').hidden = false;
}

(async function init() {
  const chrome = await siteChrome({ current: 'Pricing' });
  document.title = `Pricing · ${chrome.name}`;
  try { [pricing, me] = await Promise.all([api('GET', '/api/public/pricing'), api('GET', '/api/auth/me')]); }
  catch { plansEl.replaceChildren(h('div', { class: 'lx-err', style: { gridColumn: '1/-1' } }, 'Could not load the plans. Please refresh.')); return; }
  plansEl.replaceChildren(...pricing.plans.map(planCard));
  if (pricing.plans.length > 1) comparison(pricing.plans);
  if (pricing.plans.some(p => p.buy_url)) document.getElementById('payNote').replaceChildren(icon('key-round', 18), 'Plans are bought on BuiltByBit. Download the file you get there, then activate the key in your dashboard under Billing.');
  const cta2 = document.getElementById('ctaBtn');
  if (!pricing.signups && !(me.user && (me.user.workspace || me.user.isAdmin))) { cta2.removeAttribute('href'); cta2.textContent = 'Invite only'; cta2.classList.remove('primary'); cta2.setAttribute('aria-disabled', 'true'); }
  if (me.user) { cta2.href = '/dashboard'; cta2.textContent = me.user.workspace || me.user.isAdmin ? 'Open dashboard' : 'Get started free'; if (!me.user.workspace && !me.user.isAdmin) cta2.onclick = async e => { e.preventDefault(); try { await api('POST', '/api/workspace/ensure'); location.href = '/dashboard'; } catch (err) { showErr(err.message); } }; }
})();
