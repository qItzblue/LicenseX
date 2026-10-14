// "Redstone & Obsidian" components as plain DOM builders (the React versions in the design system are the reference).
// Everything is built with h(); icons come from the Lucide subset in /ds/icons.js.
import { h, api } from '/lib.js';
import { ICONS } from '/ds/icons.js';

const NS = 'http://www.w3.org/2000/svg';
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/** A Lucide icon. The markup is a fixed string from icons.js, parsed as SVG (never user input). */
export function icon(name, size = 20, stroke = 1.75) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'lx-ico' })) svg.setAttribute(k, v);
  const doc = new DOMParser().parseFromString(`<svg xmlns="${NS}">${ICONS[name] || ''}</svg>`, 'image/svg+xml');
  for (const n of [...doc.documentElement.childNodes]) svg.append(document.importNode(n, true));
  return svg;
}

export const logo = (name = 'LicenseX', href = '/') => {
  const m = /^(.*?)(X)$/.exec(name);   // "LicenseX" -> License + red X
  return h('a', { class: 'lx-logo', href, 'aria-label': `${name} home` }, h('span', { class: 'mark', 'aria-hidden': 'true' }),
    h('span', { class: 'word' }, m ? [m[1], h('b', null, m[2])] : name));
};
export const eyebrow = (text, tone = '') => h('span', { class: 'lx-eyebrow ' + tone }, text);
export const dot = (tone = 'valid', { pulse = false, sm = false, label } = {}) => h('span', { class: `lx-dot ${tone}${pulse ? ' pulse' : ''}${sm ? ' sm' : ''}`, ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }) });
export const badge = (tone, text, { withDot = false, pulse = false } = {}) => h('span', { class: 'lx-badge ' + (tone || '') }, withDot ? dot(tone === 'enchant' || !tone ? 'offline' : tone, { pulse, sm: true }) : null, text);
export const btn = (label, { kind = '', size = '', href, onclick, iconL, iconR, id, type, attrs = {} } = {}) => {
  const cls = ['lx-btn', kind, size].filter(Boolean).join(' ');
  const kids = [iconL && icon(iconL, size === 'sm' ? 16 : 18), label, iconR && icon(iconR, size === 'sm' ? 16 : 18)];
  return href ? h('a', { class: cls, href, id, onclick, ...attrs }, ...kids) : h('button', { class: cls, type: type || 'button', id, onclick, ...attrs }, ...kids);
};
export const head = (eb, title, sub, id) => h('div', { class: 'lx-head' }, eyebrow(eb), h('h2', { class: 'lx-h2', id }, title), sub ? h('p', { class: 'lx-sub' }, sub) : null);

/** License key chip: shimmers once, copy button, struck through when blocked. */
export function keyChip(value, { status, size = '', copyable = true, delay = 300 } = {}) {
  const blocked = status === 'blocked';
  const el = h('span', { class: `lx-key ${size}${blocked ? ' blocked' : ''}${copyable ? '' : ' nocopy'}` }, status ? dot(status === 'active' ? 'valid' : status, { sm: true }) : null, h('code', null, value));
  if (copyable) {
    const b = h('button', { type: 'button', 'aria-label': 'Copy license key' }, icon('copy', 15));
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(value); } catch {}
      b.replaceChildren(icon('check', 15)); b.classList.add('done'); b.setAttribute('aria-label', 'Copied');
      setTimeout(() => { b.replaceChildren(icon('copy', 15)); b.classList.remove('done'); b.setAttribute('aria-label', 'Copy license key'); }, 1400);
    });
    el.append(b);
  }
  if (!blocked && !reduced()) { const s = h('span', { class: 'shine', 'aria-hidden': 'true', style: { '--delay': delay + 'ms' } }); s.addEventListener('animationend', () => s.remove()); el.append(s); }
  return el;
}

export function serverSlot({ name, ip, lastSeen, online, onRemove, removeLabel = 'Remove', extra }) {
  return h('div', { class: 'lx-slot' },
    h('div', { class: 'who' }, dot(online ? 'valid' : 'offline', { pulse: online, label: online ? 'Online' : 'Offline' }),
      h('div', null, h('b', null, name, extra || null), h('code', null, ip))),
    h('span', { class: 'seen' }, 'Last seen ', h('span', null, lastSeen)),
    onRemove ? btn(removeLabel, { kind: 'danger', size: 'sm', iconL: 'trash-2', onclick: onRemove }) : null);
}
export const emptySlot = () => h('div', { class: 'lx-slot empty' }, dot('offline'), 'Empty slot. The next server that starts the plugin takes it.');

/** The typing server console of the hero. lines: [{ time, text, tone }] (tone: info|muted|ok|warn|error). */
export function consolePanel(title, lines, { loop = true } = {}) {
  const rows = lines.map(l => {
    const m = h('span', { class: 'm' });
    return { l, m, row: h('div', { class: 'ln ' + (l.tone || ''), style: { visibility: 'hidden' } }, h('span', { class: 't' }, l.time), m) };
  });
  const caret = h('span', { class: 'caret', 'aria-hidden': 'true' });
  const paint = (r, text) => {
    const px = /^(\[LicenseX\])(.*)$/s.exec(text);
    r.m.replaceChildren(...(px ? [h('span', { class: 'px' }, px[1]), px[2]] : [text]));
  };
  const el = h('div', { class: 'lx-console' },
    h('div', { class: 'bar' }, h('code', null, title), h('span', { class: 'live' }, dot('live', { pulse: true, sm: true }), 'LIVE')),
    h('div', { class: 'log', role: 'log', 'aria-label': 'Server console' }, rows.map(r => r.row)));
  if (reduced()) { for (const r of rows) { paint(r, r.l.text); r.row.style.visibility = 'visible'; } return el; }
  let i = 0, c = 0;
  const tick = () => {
    if (!el.isConnected && i > 0) return;
    if (i >= rows.length) {
      if (!loop) return;
      return setTimeout(() => { for (const r of rows) { r.row.style.visibility = 'hidden'; r.m.replaceChildren(); } i = 0; c = 0; tick(); }, 5000);
    }
    const r = rows[i], text = r.l.text;
    r.row.style.visibility = 'visible';
    c = Math.min(text.length, c + 2);
    paint(r, text.slice(0, c)); r.m.append(caret);
    if (c < text.length) setTimeout(tick, 18);
    else { i++; c = 0; setTimeout(tick, 420); }
  };
  setTimeout(tick, 400);
  return el;
}

/** 9-slot inventory hotbar with the purple item tooltip. items: [{ icon, label, title, description }]. */
export function hotbar(items, label = 'Features') {
  const title = h('b'), desc = h('span');
  const tip = h('div', { class: 'lx-tooltip', role: 'tabpanel', 'aria-live': 'polite' }, title, desc);
  const slots = items.map((it, i) => h('button', { type: 'button', role: 'tab', class: 'lx-hslot', 'aria-selected': 'false', tabindex: '-1' },
    h('span', { class: 'n' }, String(i + 1)), icon(it.icon, 26, 1.6), h('span', { class: 'l' }, it.label)));
  const select = (i, focus) => {
    slots.forEach((s, j) => { s.setAttribute('aria-selected', String(i === j)); s.tabIndex = i === j ? 0 : -1; });
    title.textContent = items[i].title || items[i].label; desc.textContent = items[i].description;
    title.style.animation = desc.style.animation = 'none'; void title.offsetWidth; title.style.animation = desc.style.animation = '';
    if (focus) slots[i].focus();
  };
  slots.forEach((s, i) => {
    s.addEventListener('click', () => select(i)); s.addEventListener('mouseenter', () => select(i)); s.addEventListener('focus', () => select(i));
    s.addEventListener('keydown', e => {
      const n = items.length;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); select((i + 1) % n, true); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); select((i - 1 + n) % n, true); }
      else if (/^[1-9]$/.test(e.key) && +e.key <= n) { e.preventDefault(); select(+e.key - 1, true); }
    });
  });
  const empties = Array.from({ length: Math.max(0, 9 - items.length) }, () => h('div', { class: 'lx-hslot empty', 'aria-hidden': 'true' }));
  select(0);
  return h('div', null, h('div', { class: 'lx-hotbar lx-hotbar-box', role: 'tablist', 'aria-label': label }, slots, empties), tip);
}

/** Sections with class lx-circuit power on (node lights up, dust flows) when they scroll into view. */
export function powerCircuits(root = document) {
  const els = [...root.querySelectorAll('.lx-circuit:not(.on)')];
  if (typeof IntersectionObserver === 'undefined') return els.forEach(e => e.classList.add('on'));
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('on'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -35% 0px' });
  els.forEach(e => io.observe(e));
}
export const circuit = (id, body, { first = false, last = false, labelledby } = {}) =>
  h('section', { class: `lx-circuit${first ? ' first' : ''}${last ? ' last' : ''}`, id, 'aria-labelledby': labelledby }, h('div', { class: 'trace', 'aria-hidden': 'true' }), h('div', { class: 'body' }, body));

/** Six digit boxes. The first box has `id` (so a whole code can be typed or pasted into it). */
export function otp({ id = 'code', length = 6, onComplete } = {}) {
  const boxes = Array.from({ length }, (_, i) => h('input', { inputmode: 'numeric', autocomplete: i ? 'off' : 'one-time-code', maxlength: length, 'aria-label': `Digit ${i + 1} of ${length}`, ...(i ? {} : { id }) }));
  const value = () => boxes.map(b => b.value).join('');
  const set = (digits, from = 0) => {
    digits.forEach((d, k) => { if (from + k < length) boxes[from + k].value = d; });
    boxes.forEach(b => b.classList.toggle('on', !!b.value));
    const next = Math.min(length - 1, from + digits.length);
    boxes[next].focus();
    if (value().length === length && /^\d+$/.test(value())) onComplete?.(value());
  };
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => { const d = b.value.replace(/\D/g, ''); b.value = ''; if (d) set(d.slice(0, length - i).split(''), i); else b.classList.remove('on'); wrap.classList.remove('bad'); });
    b.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !b.value && i > 0) { e.preventDefault(); boxes[i - 1].value = ''; boxes[i - 1].classList.remove('on'); boxes[i - 1].focus(); }
      else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); boxes[i - 1].focus(); }
      else if (e.key === 'ArrowRight' && i < length - 1) { e.preventDefault(); boxes[i + 1].focus(); }
    });
    b.addEventListener('paste', e => { const d = (e.clipboardData.getData('text') || '').replace(/\D/g, ''); if (d) { e.preventDefault(); set(d.slice(0, length - i).split(''), i); } });
    b.addEventListener('focus', () => b.select());
  });
  const kids = []; boxes.forEach((b, i) => { if (i === length / 2 && length % 2 === 0) kids.push(h('span', { class: 'dash', 'aria-hidden': 'true' })); kids.push(b); });
  const wrap = h('div', { class: 'lx-otp', role: 'group', 'aria-label': 'Two-factor code' }, kids);
  return { el: wrap, value, clear: () => { boxes.forEach(b => { b.value = ''; b.classList.remove('on'); }); boxes[0].focus(); }, bad: on => wrap.classList.toggle('bad', on), focus: () => boxes[0].focus() };
}

// --- site chrome: header (with sign-in state) and footer, shared by the public pages ----------------------------------------
export const safeUrl = u => { try { return /^https?:$/.test(new URL(u).protocol) ? u : ''; } catch { return ''; } };
const ext = { target: '_blank', rel: 'noopener noreferrer' };

export async function siteChrome({ current = '' } = {}) {
  let site = {}, me = { user: null, providers: [] };
  try { [site, me] = await Promise.all([api('GET', '/api/public/site'), api('GET', '/api/auth/me')]); } catch {}
  const name = site.site_name || 'LicenseX';
  const links = [['Features', '/#features'], ['Pricing', '/pricing'], ['Check a license', '/#check']];
  const navLink = ([t, href]) => h('a', { href, ...(current === t ? { 'aria-current': 'page' } : {}) }, t);
  const auth = h('span', { class: 'grp', id: 'authNav' });
  if (!me.user) auth.append(h('a', { href: '/login', class: 'pill lx-btn sm' }, icon('log-in', 16), 'Sign in'));
  else {
    const u = me.user;
    auth.append(...[h('a', { href: '/account' }, 'My licenses'),
      u.isAdmin ? btn('Admin', { href: '/admin', size: 'sm', kind: 'primary' }) : u.workspace ? btn('Dashboard', { href: '/dashboard', size: 'sm', kind: 'primary' }) : null,
      h('button', { class: 'linklike', type: 'button', onclick: async () => { await api('POST', '/api/auth/logout'); location.reload(); } }, 'Sign out')].filter(Boolean));
  }
  const mobile = h('nav', { class: 'lx-mobile', 'aria-label': 'Main mobile', hidden: true }, links.map(navLink), me.user ? h('a', { href: '/account' }, 'My licenses') : h('a', { href: '/login' }, 'Sign in'));
  const menu = h('button', { class: 'lx-iconbtn lx-menu', type: 'button', 'aria-label': 'Open menu', 'aria-expanded': 'false' }, icon('menu', 20));
  menu.addEventListener('click', () => { const open = mobile.hidden; mobile.hidden = !open; menu.setAttribute('aria-expanded', String(open)); menu.replaceChildren(icon(open ? 'x' : 'menu', 20)); });
  const header = h('header', { class: 'lx-header' }, h('div', { class: 'lx-wrap' }, logo(name),
    h('nav', { class: 'top', 'aria-label': 'Main' }, h('span', { class: 'grp lx-links' }, links.map(navLink), h('span', { class: 'sep' })), auth), menu), mobile);
  const foot = [[safeUrl(site.discord_url), 'Discord', ext], [safeUrl(site.store_url), 'BuiltByBit', ext], [safeUrl(site.website_url), 'Website', ext], [site.support_email && 'mailto:' + site.support_email, 'Contact', {}], ['/admin', 'Admin', {}]].filter(([u]) => u);
  const footer = h('footer', { class: 'lx-footer' }, h('div', { class: 'lx-wrap' },
    h('div', { class: 'row wrap', style: { gap: '16px' } }, logo(name), h('span', { class: 'note', id: 'footText' }, `© ${new Date().getFullYear()} ${name}`)),
    h('nav', { 'aria-label': 'Footer', id: 'footLinks' }, foot.map(([u, t, a]) => h('a', { href: u, ...a }, t)))));
  document.getElementById('lxHeader')?.replaceWith(header);
  document.getElementById('lxFooter')?.replaceWith(footer);
  return { site, me, name };
}
