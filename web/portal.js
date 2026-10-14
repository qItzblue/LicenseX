import { h, api, toast, confirmDialog, ago, date, limitText } from '/lib.js';
import { icon, eyebrow, btn, head, badge, keyChip, serverSlot, emptySlot, consolePanel, hotbar, circuit, powerCircuits, siteChrome } from '/lx.js';

// The public home page: hero, "check a license" (the buyer's self-service), features, how it works, the leak tracer and FAQ.
const KEY_STORE = 'licensex.key';
const KEY_RE = /^LX(-[A-Z0-9]{4}){4}$/;
/** Typing helper: "lx39qktyma..." becomes "LX-39QK-TYMA-...". */
function formatKey(raw) {
  let s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('LX')) s = s.slice(2);
  const parts = s.slice(0, 16).match(/.{1,4}/g);
  return parts ? 'LX-' + parts.join('-') : raw.toUpperCase().replace(/[^LX-]/g, '').slice(0, 3);
}

const HERO_LINES = [
  { time: '02:14:01', text: '[Server] Starting Paper 1.21.1 on Survival-EU', tone: 'muted' },
  { time: '02:14:02', text: '[LicenseX] Loading EconomyPlus v3.2.0', tone: 'info' },
  { time: '02:14:03', text: '[LicenseX] Checking key LX-39QK-TYMA-DVWK-5AUR', tone: 'info' },
  { time: '02:14:04', text: '[LicenseX] License valid · 2/3 servers · heartbeat ok', tone: 'ok' },
  { time: '02:14:05', text: '[Server] Done (4.218s)! For help, type "help"', tone: 'muted' },
  { time: '02:16:41', text: '[LicenseX] Unknown server joined with key LX-F2JD-…-0ZLE', tone: 'warn' },
  { time: '02:16:41', text: '[LicenseX] Blocked: leaked copy traced to download #4242', tone: 'error' },
];
const FEATURES = [
  { icon: 'code-xml', label: 'No code changes', title: 'No code changes', description: "We wrap your jar. You don't add a single line to your plugin." },
  { icon: 'store', label: 'BuiltByBit', title: 'BuiltByBit integration', description: 'Paste one download link into your resource and every download is issued its own key.' },
  { icon: 'scan-search', label: 'Leak tracer', title: 'Leak tracer', description: "Upload a leaked jar and see which buyer's copy it was, when and from where it was downloaded." },
  { icon: 'server', label: 'Server limits', title: 'Server limits per license', description: 'Set how many servers can run one key. Buyers free up slots themselves.' },
  { icon: 'user-round', label: 'Buyer portal', title: 'Buyer portal', description: 'Buyers see their keys and servers without opening a ticket.' },
  { icon: 'users', label: 'Team roles', title: 'Team roles with product access', description: 'Give helpers access to the products they support, and nothing else.' },
  { icon: 'fingerprint', label: 'Two-factor', title: 'Two-factor sign-in', description: 'Six-digit codes from any authenticator app, with recovery codes.' },
  { icon: 'database-backup', label: 'Backups', title: 'Off-site backups', description: 'Encrypted copies to your own storage or Discord, restored by themselves after a wipe.' },
];
const STEPS = [
  { icon: 'upload', title: 'Upload your jar', body: 'We add the license check and a hidden mark. Your source stays untouched.' },
  { icon: 'link', title: 'Paste the download link into BuiltByBit', body: 'Use it as the external download on your resource page.' },
  { icon: 'key-round', title: 'Every buyer gets their own key automatically', body: 'Each download is marked and tied to the buyer who made it.' },
];
const FAQ = [
  ['Where do I find my license key?', ['In your server console when the plugin starts: it prints your key and a personal link. The key looks like ', h('code', null, 'LX-XXXX-XXXX-XXXX-XXXX'), '.']],
  ['How many servers can I use it on?', ['The limit is shown on your license above. Each running server uses one slot.']],
  ['I moved my server. How do I free the old slot?', ['Check your key, press Remove next to the old server, then start the new one. The old server stops working the next time it checks in, about a minute later.']],
  ['Will I get a new key if I download the plugin again?', ['No. Your license belongs to your BuiltByBit account, so every download carries the same key.']],
  ['Who can see my license?', ["Only someone who has your key. Treat it like a password and don't post your console log publicly."]],
  ['My license says blocked or expired.', ['Contact the plugin\'s creator with your key and they can sort it out.']],
];

// --- check a license ---------------------------------------------------------------------------------------------------
const result = h('div', { id: 'result', hidden: true, 'aria-live': 'polite' });
const keyIn = h('input', { id: 'key', placeholder: 'LX-XXXX-XXXX-XXXX-XXXX', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'characters', 'aria-label': 'License key', 'aria-describedby': 'keyMsg' });
const inputBox = h('div', { class: 'lx-input' }, icon('key', 18), keyIn, btn('Check', { kind: 'primary', size: 'sm', type: 'submit', id: 'checkBtn', attrs: { style: { height: '38px' } } }));
const msg = h('span', { class: 'msg', id: 'keyMsg' }, 'Paste the key from your BuiltByBit purchase or your server console.');
const hint = h('p', { class: 'acct-hint', id: 'acctHint', hidden: true });
const form = h('form', { id: 'form', novalidate: true }, h('div', { class: 'lx-field' }, h('label', { for: 'key' }, 'License key'), inputBox, msg));
keyIn.addEventListener('input', () => { const at = keyIn.selectionStart === keyIn.value.length; keyIn.value = formatKey(keyIn.value); if (at) keyIn.selectionStart = keyIn.selectionEnd = keyIn.value.length; inputBox.classList.remove('bad'); });
form.addEventListener('submit', e => { e.preventDefault(); lookup(keyIn.value.trim()); });

const showError = text => { inputBox.classList.add('bad'); msg.className = 'msg bad'; msg.textContent = text; result.hidden = true; };
async function lookup(key, { silent } = {}) {
  key = formatKey(key);
  keyIn.value = key;
  if (!KEY_RE.test(key)) { if (!silent) showError('Keys look like LX-XXXX-XXXX-XXXX-XXXX.'); return; }
  const b = document.getElementById('checkBtn'); b.disabled = true; b.textContent = 'Checking…';
  try {
    const v = await api('POST', '/api/public/lookup', { key });
    try { sessionStorage.setItem(KEY_STORE, key); } catch {}
    msg.className = 'msg'; msg.textContent = 'Paste the key from your BuiltByBit purchase or your server console.';
    render(v);
  } catch (e) { if (!silent) showError(e.message); }
  finally { b.disabled = false; b.textContent = 'Check'; }
}

const online = s => s.status === 'active' && Date.now() / 1000 - s.last_seen < 15 * 60;
function render(v) {
  const state = { active: ['valid', 'Valid'], blocked: ['blocked', 'Blocked'], expired: ['warn', 'Expired'] }[v.state] || ['', v.state];
  const limit = v.limit === -1 ? null : v.limit;
  const slots = v.servers.map(s => serverSlot({ name: s.name || 'Unnamed server', ip: `${s.ip}${s.port ? ':' + s.port : ''}`, lastSeen: ago(s.last_seen), online: online(s),
    extra: s.status === 'disabled' ? h('span', { class: 'lx-badge blocked', style: { marginLeft: '8px' } }, 'Disabled by the creator') : null,
    onRemove: v.public_removal && s.status !== 'disabled' ? () => remove(v, s) : null }));
  const free = limit == null ? 0 : Math.max(0, Math.min(6, limit - v.used));
  result.replaceChildren(h('div', { class: 'result lx-fade' },
    h('div', { class: 'top' },
      h('div', { class: 'info' }, keyChip(v.key, { status: state[0] === 'valid' ? 'valid' : state[0] === 'blocked' ? 'blocked' : 'warn', delay: 100 }),
        h('span', { class: 'meta' }, [v.owner && `Licensed to ${v.owner}`, `issued ${date(v.created_at)}`, v.expires_at && `expires ${date(v.expires_at)}`].filter(Boolean).join(' · '))),
      h('div', { class: 'badges' }, badge(state[0], state[1], { withDot: true }), badge('', `${v.used} / ${limitText(v.limit)} servers`),
        v.group ? h('span', { class: 'tag', style: { '--c': v.group.color } }, v.group.name) : null)),
    v.block_reason ? h('p', { class: 'lx-err', style: { margin: 0 } }, v.block_reason) : null,
    v.state === 'blocked' && !v.block_reason ? h('p', { class: 'muted', style: { margin: 0, fontSize: '14px' } }, "This license no longer starts on any server. If you think this is a mistake, contact the plugin's creator.") : null,
    h('div', { class: 'slots' }, slots, Array.from({ length: free }, emptySlot),
      !v.servers.length && limit == null ? h('div', { class: 'lx-slot empty' }, 'No servers are using this license yet. Start your server with the plugin installed and it shows up here.') : null),
    !v.public_removal && v.servers.length ? h('p', { class: 'muted', style: { margin: 0, fontSize: '13px' } }, 'Removing servers yourself is switched off for this plugin. Contact its creator.') : null));
  result.hidden = false;
}
async function remove(v, s) {
  if (!await confirmDialog('Remove this server?', `${s.name || 'This server'} (${s.ip}) stops working with this license the next time it checks in, and its slot becomes free.`, 'Remove server')) return;
  try { render(await api('POST', '/api/public/remove', { key: v.key, serverId: s.id })); toast('Server removed'); }
  catch (e) { toast(e.message, true); }
}

// --- leak tracer showcase (the real one lives in the dashboard) ---------------------------------------------------------------
function tracer() {
  const out = h('div', { class: 'lx-card well tracer-wait', style: { flex: 1 } }, h('span', { style: { color: 'var(--fg-disabled)' } }, icon('scan-search', 28)), h('b', { class: 'muted' }, 'The result shows up here'));
  const box = h('div', { style: { display: 'flex' } }, out);
  const wait = (text, ...more) => box.replaceChildren(h('div', { class: 'lx-card well tracer-wait lx-fade', style: { flex: 1 } }, h('span', { style: { color: 'var(--accent)' } }, icon('scan-search', 28)), h('b', null, text), ...more));
  const sample = () => {
    wait('Matching against 1,284 downloads…');
    setTimeout(() => {
      let blocked = false;
      const actions = h('div', { class: 'row wrap', style: { marginTop: 'auto', gap: '12px' } });
      const chip = h('span');
      const draw = () => {
        chip.replaceChildren(keyChip('LX-F2JD-91XR-QWPA-0ZLE', { size: 'sm', status: blocked ? 'blocked' : 'valid' }));
        actions.replaceChildren(...(blocked ? [badge('blocked', 'License blocked', { withDot: true }), h('span', { class: 'muted', style: { fontSize: '13px' } }, 'Their servers stop loading the plugin on the next heartbeat.')]
          : [btn('Block license', { kind: 'primary', iconL: 'ban', onclick: () => { blocked = true; draw(); } })]));
      };
      draw();
      box.replaceChildren(h('div', { class: 'lx-card hot tracer-res lx-fade', style: { flex: 1 } },
        h('div', { class: 'row wrap spread' }, badge('blocked', 'Match found', { withDot: true, pulse: true }), h('code', { class: 'muted', style: { fontSize: '12px' } }, 'EconomyPlus-3.2.0-cracked.jar · sample')),
        h('h3', null, 'Found the leaker'),
        h('dl', { class: 'lx-dl' }, h('dt', null, 'Downloaded'), h('dd', null, '12 Oct, 14:02'), h('dt', null, 'IP'), h('dd', null, h('code', null, '203.0.113.7')),
          h('dt', null, 'BuiltByBit user'), h('dd', null, h('code', null, '4242')), h('dt', null, 'License'), h('dd', null, chip)),
        actions));
    }, 1200);
  };
  const file = h('input', { type: 'file', accept: '.jar', hidden: true });
  const drop = h('div', { class: 'lx-drop', style: { flex: 1 } }, h('span', { class: 'lx-well' }, icon('file-archive', 26)),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, h('b', null, 'Drop a leaked .jar here'), h('p', null, 'Every copy carries a hidden mark. We read it and match it to a download.')),
    file, btn('Choose file', { size: 'sm', iconL: 'upload', onclick: () => file.click() }));
  // On this public page a real file is not uploaded anywhere: tracing runs in the creator's dashboard, against their own downloads.
  const real = f => wait(`${f.name}`, h('p', { class: 'muted', style: { margin: 0, maxWidth: '320px', fontSize: '14px' } }, 'Tracing runs in your dashboard, against your own downloads. Sign in and open Leak tracer.'),
    btn('Open the leak tracer', { kind: 'primary', href: '/dashboard#leaks', iconR: 'arrow-right' }));
  file.addEventListener('change', () => file.files[0] && real(file.files[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) real(f); });
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '40px' } },
    head('Leak tracer', 'Found a leak? Find the leaker.', 'Drop the leaked jar and see the buyer, the time and the IP of the download it came from.', 'tracer-title'),
    h('div', { class: 'lx-2', style: { alignItems: 'stretch' } },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, drop, h('div', null, btn('Try with a sample jar', { kind: 'ghost', size: 'sm', iconL: 'package', onclick: sample }))),
      box));
}

// --- page ----------------------------------------------------------------------------------------------------------------
(async function init() {
  const { site, me, name } = await siteChrome();
  document.title = `${name} · Your plugin. Your buyers. No leaks.`;
  const startHref = me.user ? (me.user.isAdmin ? '/admin' : '/dashboard') : '/login/creator';
  const main = document.getElementById('main');
  main.replaceChildren(
    h('section', { class: 'hero-sec', 'aria-labelledby': 'hero-title' }, h('div', { class: 'lx-wrap lx-hero' },
      h('div', { class: 'hero-copy' }, eyebrow('For Spigot and Paper plugins on BuiltByBit'),
        h('h1', { class: 'lx-display', id: 'hero-title' }, 'Your plugin. Your buyers. ', h('span', { class: 'hot' }, 'No leaks.')),
        h('p', { class: 'lx-lead', id: 'tagline' }, site.site_tagline || 'Every download gets its own license key and a hidden mark. Upload a leaked jar and see exactly whose copy it was.'),
        h('div', { class: 'ctas' }, btn(me.user?.workspace || me.user?.isAdmin ? 'Open your dashboard' : 'Start free as a creator', { kind: 'primary', size: 'lg', href: startHref, iconR: 'arrow-right' }),
          btn('I bought a plugin', { size: 'lg', href: '#check', iconL: 'key-round' }))),
      consolePanel('Survival-EU — logs/latest.log', HERO_LINES))),
    h('div', { class: 'lx-wrap' },
      circuit('check', h('div', { class: 'lx-split' },
        head('Check a license', 'Bought a plugin? Check your key.', 'See its status and which servers are using it, and free up a slot when you move.', 'check-title'),
        h('div', { class: 'lx-card' }, form, hint, result)), { first: true, labelledby: 'check-title' }),
      circuit('features', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '40px' } },
        head('Features', 'Everything you need, in one hotbar.', 'Hover or tab through the slots. Use the arrow keys or 1–8 to switch.', 'features-title'), hotbar(FEATURES, `${name} features`)), { labelledby: 'features-title' }),
      circuit('how', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '40px' } },
        head('How it works', 'Three steps. No code.', null, 'how-title'),
        h('ol', { class: 'lx-3 steps' }, STEPS.map((s, i) => h('li', null, h('div', { class: 'lx-card interactive' },
          h('div', { class: 'row spread' }, h('span', { class: 'lx-well' }, icon(s.icon, 22)), h('span', { class: 'num' }, '0' + (i + 1))),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, h('h3', null, s.title), h('p', null, s.body)),
          i === 2 ? h('div', { style: { marginTop: 'auto' } }, keyChip('LX-8HPN-2WQC-LZ4E-KM7T', { size: 'sm', delay: 900 })) : null))))), { labelledby: 'how-title' }),
      circuit('tracer', tracer(), { labelledby: 'tracer-title' }),
      circuit('faq', h('div', { class: 'lx-split' },
        head('Questions', 'The quick answers.', 'Anything else? Ask the creator of your plugin, or use the links at the bottom of this page.', 'faq-title'),
        h('div', null, FAQ.map(([q, a]) => h('details', { class: 'lx-faq' }, h('summary', null, q), h('p', null, ...a))))), { labelledby: 'faq-title' }),
      circuit('devs', h('div', { class: 'lx-card hot devs' }, eyebrow('For plugin developers'),
        h('h2', { class: 'lx-h2', style: { marginTop: '16px' } }, 'Selling your own plugins?'),
        h('p', { class: 'lx-sub', style: { maxWidth: '480px', margin: '12px auto 0' } }, 'Add license protection to your plugin without touching its code. Free to start.'),
        h('div', { class: 'ctas' }, btn('Start free as a creator', { kind: 'primary', size: 'lg', href: startHref, iconR: 'arrow-right' }), btn('See plans and pricing', { size: 'lg', href: '/pricing' }))), { last: true })));
  powerCircuits(main);

  if (me.user) { hint.replaceChildren('Signed in as ', h('b', null, me.user.name), '. ', h('a', { href: '/account' }, 'See all your licenses'), ' in one place.'); hint.hidden = false; }
  else if (me.providers.length) { hint.replaceChildren('Have more than one license? ', h('a', { href: '/login/buyer' }, 'Sign in'), ' to keep them all in one place.'); hint.hidden = false; }

  const linked = new URLSearchParams(location.search).get('key');
  if (linked) { lookup(linked.trim()); history.replaceState(null, '', location.pathname + '#check'); document.getElementById('check').scrollIntoView(); }
  else try { const k = sessionStorage.getItem(KEY_STORE); if (k) lookup(k, { silent: true }); } catch {}
  if (location.hash && location.hash.length > 1) document.getElementById(location.hash.slice(1))?.scrollIntoView();
})();
