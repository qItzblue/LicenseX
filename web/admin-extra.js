import { h, api, toast, ago, date, copy, wsHeaders, confirmDialog } from '/lib.js';
import qrcode from '/vendor/qrcode.mjs';

const can = perm => (window.__me?.permissions || []).includes(perm);
const card = (...kids) => h('div', { class: 'card', style: { maxWidth: '680px', marginBottom: '16px' } }, ...kids);
const title = t => h('h3', { style: { marginBottom: '4px' } }, t);
const lead = t => h('p', { class: 'muted', style: { marginTop: 0, fontSize: '14px' } }, t);
const when = ts => (ts ? `${new Date(ts * 1000).toLocaleString()} (${ago(ts)})` : '—');

/** QR code as an SVG built from DOM nodes (no innerHTML). */
function qrSvg(text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), pad = 4, size = n + pad * 2, NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`); svg.setAttribute('width', '200'); svg.setAttribute('height', '200');
  svg.setAttribute('shape-rendering', 'crispEdges'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'QR code for your authenticator app');
  const bg = document.createElementNS(NS, 'rect'); bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#fff');
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  const path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}

const codeInput = (id, placeholder = '123456') => h('input', { id, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, placeholder, style: { maxWidth: '220px', fontFamily: 'var(--mono)', letterSpacing: '.15em' } });

function recoveryBox(codes) {
  const text = codes.join('\n');
  const file = () => { const a = h('a', { href: URL.createObjectURL(new Blob([`LicenseX recovery codes (each works once)\n\n${text}\n`], { type: 'text/plain' })), download: 'licensex-recovery-codes.txt' }); a.click(); };
  return h('div', { class: 'notice warn', style: { display: 'block' } },
    h('b', null, 'Save these recovery codes now. '), 'They are shown only once. Each one lets you in a single time if you lose your phone.',
    h('pre', { class: 'mono', style: { margin: '12px 0', fontSize: '15px', columns: 2, lineHeight: '1.7' } }, text),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => copy(text) }, 'Copy'), h('button', { class: 'btn sm', onclick: file }, 'Download .txt')));
}

// --- Security: two-factor sign-in for your own account -------------------------------------------------------------
export async function securityPage({ render, head }) {
  const st = await api('GET', '/api/admin/2fa');
  const area = h('div');
  const show = (...kids) => area.replaceChildren(...kids.filter(Boolean));

  const off = () => show(
    h('p', null, h('span', { class: 'chip idle' }, 'Off')),
    lead('With two-factor sign-in, signing in also needs a 6-digit code from an app on your phone (Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden...). Someone who has your password or your Google/Discord/GitHub account still cannot get in.'),
    h('button', { class: 'btn primary', id: 'tfaSetup', onclick: setup }, 'Set up two-factor sign-in'));

  async function setup() {
    let s; try { s = await api('POST', '/api/admin/2fa/setup'); } catch (e) { return toast(e.message, true); }
    const input = codeInput('tfaCode'), err = h('div', { class: 'err', hidden: true });
    const enable = async () => {
      try {
        const r = await api('POST', '/api/admin/2fa/enable', { code: input.value.trim() });
        toast('Two-factor sign-in is on');
        show(h('p', null, h('span', { class: 'chip active' }, 'On')), recoveryBox(r.recovery_codes), h('button', { class: 'btn', onclick: () => securityPage({ render, head }) }, "I've saved them"));
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    show(
      h('ol', { style: { paddingLeft: '20px', lineHeight: 1.7 } },
        h('li', null, 'Open your authenticator app and add an account.'),
        h('li', null, 'Scan this QR code, or type the key below by hand.'),
        h('li', null, 'Enter the 6-digit code the app shows.')),
      h('div', { class: 'row wrap', style: { gap: '20px', alignItems: 'center' } },
        h('div', { style: { background: '#fff', padding: '6px', borderRadius: '8px', lineHeight: 0 } }, qrSvg(s.uri)),
        h('div', null, h('label', null, 'Key'), h('div', { class: 'url-row' }, h('input', { class: 'mono', readonly: true, value: s.secret, id: 'tfaSecret', onclick: e => e.target.select() }), h('button', { class: 'btn sm', onclick: () => copy(s.secret) }, 'Copy')),
          h('div', { class: 'hint' }, 'Time-based, 6 digits, 30 seconds.'))),
      h('div', { class: 'field', style: { marginTop: '16px' } }, h('label', null, 'Code from the app'), input), err,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', id: 'tfaEnable', onclick: enable }, 'Turn on'), h('button', { class: 'btn ghost', onclick: off }, 'Cancel')));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') enable(); });
    input.focus();
  }

  const on = () => {
    const input = codeInput('tfaCode', 'code or recovery code'), err = h('div', { class: 'err', hidden: true }), extra = h('div');
    const withCode = async (path, done) => {
      try { const r = await api('POST', path, { code: input.value.trim() }); input.value = ''; err.hidden = true; done(r); }
      catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    show(
      h('p', null, h('span', { class: 'chip active' }, 'On'), ' ', h('span', { class: 'muted' }, `since ${date(st.since)} · ${st.recovery_left} recovery code${st.recovery_left === 1 ? '' : 's'} left`)),
      st.recovery_left <= 2 ? h('div', { class: 'notice warn' }, 'You are running out of recovery codes. Make new ones below.') : null,
      lead('To change something, enter a current code from your app (or a recovery code).'),
      h('div', { class: 'field' }, input), err,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: () => withCode('/api/admin/2fa/recovery', r => extra.replaceChildren(recoveryBox(r.recovery_codes))) }, 'New recovery codes'),
        h('button', { class: 'btn danger', id: 'tfaOff', onclick: async () => {
          if (!await confirmDialog('Turn off two-factor sign-in?', 'Signing in will only need your password or your Google/Discord/GitHub account again.', 'Turn off')) return;
          withCode('/api/admin/2fa/disable', () => { toast('Two-factor sign-in is off'); securityPage({ render, head }); });
        } }, 'Turn off')),
      extra);
  };
  st.enabled ? on() : off();

  let reset = null;
  if (window.__me.role === 'platform') {
    const email = h('input', { type: 'email', placeholder: 'their@email.com', style: { maxWidth: '320px' } });
    reset = card(title('Locked out?'),
      lead('Somebody who lost their phone and their recovery codes can be let back in by switching two-factor off for their email address. Make sure it is really them first. (For the admin password itself, start the server once with LICENSEX_RESET_2FA=password.)'),
      h('div', { class: 'row wrap' }, email, h('button', { class: 'btn', onclick: async () => {
        try { const r = await api('POST', '/api/admin/2fa/reset', { email: email.value }); toast(r.was_on ? 'Two-factor switched off for that account' : 'That account did not have two-factor on'); email.value = ''; }
        catch (e) { toast(e.message, true); }
      } }, 'Switch it off')));
  }
  render(head('Security'), card(title('Two-factor sign-in'), h('p', { class: 'muted', style: { marginTop: 0, fontSize: '14px' } }, `For ${st.account}.`), area), reset);
}

// --- Leak tracer ---------------------------------------------------------------------------------------------------------
const VERDICTS = {
  match: ['bad', 'Found the leaker', 'This file is the copy downloaded below, still with its own license key.'],
  key_swapped: ['bad', 'Found the download, but the key was swapped', 'The hidden mark says who downloaded this copy, but someone put another license key in it. Both licenses are shown.'],
  mark_only: ['bad', 'Found the download', 'The license key was removed from this file, but the hidden mark says who downloaded it.'],
  key_only: ['warn', 'Found the license', 'This file has a license key from your workspace but no download mark (it was made before marks existed, or by the BuiltByBit placeholder, or the mark was stripped).'],
  license_deleted: ['warn', 'Found the download, but its license was deleted', 'The download is known, but its license no longer exists.'],
  none: ['', 'Nothing found', 'This file has no license key or download mark from your workspace. It may be a copy of the original upload, from another seller, or cleaned up by the leaker.'],
};

export async function leaksPage({ render, head }) {
  const out = h('div');
  const input = h('input', { type: 'file', accept: '.jar,.zip', hidden: true, id: 'leakFile', onchange: e => e.target.files[0] && trace(e.target.files[0]) });
  const drop = h('div', { class: 'card', style: { maxWidth: '680px', marginBottom: '16px', textAlign: 'center', padding: '36px', border: '2px dashed var(--line, #333)', cursor: 'pointer' }, onclick: () => input.click() },
    h('h3', null, 'Drop a leaked .jar here'), h('p', { class: 'muted', style: { margin: '6px 0 0' } }, 'or click to pick the file. It is only read to find its marks; it is not stored.'), input);
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
  drop.addEventListener('drop', e => { e.preventDefault(); drop.style.borderColor = ''; const f = e.dataTransfer.files[0]; if (f) trace(f); });

  async function trace(file) {
    out.replaceChildren(card(h('span', { class: 'muted' }, `Reading ${file.name}...`)));
    try {
      const r = await fetch('/api/admin/leaks/trace', { method: 'POST', headers: { ...wsHeaders(), 'X-Filename': file.name }, body: file });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not read the file');
      out.replaceChildren(...result(d, file.name));
    } catch (e) { out.replaceChildren(card(h('div', { class: 'err' }, e.message))); }
    input.value = '';
  }

  render(head('Leak tracer'),
    h('p', { class: 'muted', style: { maxWidth: '680px', marginTop: 0 } }, 'Every jar people download gets their own license key and a hidden mark. Found your plugin on a leak site? Upload the jar to see whose copy it was, when and from where it was downloaded, and block it.'),
    drop, out);
}

function result(d, filename) {
  const [kind, head, text] = VERDICTS[d.verdict] || VERDICTS.none;
  const rows = (pairs) => h('table', { class: 'kv' }, h('tbody', null, pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => h('tr', null, h('td', { class: 'muted', style: { paddingRight: '16px', verticalAlign: 'top' } }, k), h('td', null, v)))));
  const out = [h('div', { class: 'notice ' + kind, id: 'leakVerdict', style: { maxWidth: '680px' } }, h('span', null, h('b', null, head + '. '), text))];
  if (d.download) out.push(card(title('The download'), rows([
    ['Downloaded', when(d.download.at)], ['IP address', h('span', { class: 'mono' }, d.download.ip)], ['Browser', d.download.user_agent],
    ['BuiltByBit user id', d.download.bbb_user], ['Product', d.download.product], ['License key', h('span', { class: 'keycell' }, d.download.license_key)]])));
  for (const [lic, label] of [[d.license, 'License'], [d.other_license, 'License whose key is in the file']]) if (lic) out.push(licenseCard(lic, label, rows, filename));
  out.push(h('p', { class: 'faint', style: { fontSize: '13px', maxWidth: '680px' } }, `File: ${filename} · key in file: ${d.file.key || 'none'} · marks: ${d.file.marks.join(', ') || 'none'}`));
  return out;
}

function licenseCard(lic, label, rows, filename) {
  const status = h('span', { class: 'chip ' + (lic.status === 'blocked' ? 'blocked' : 'active') }, lic.status === 'blocked' ? 'Blocked' : 'Active');
  const block = can('licenses.block') && lic.status !== 'blocked' ? h('button', { class: 'btn danger', onclick: async e => {
    if (!await confirmDialog('Block this license?', `Every server using ${lic.key} stops working at its next check-in.`, 'Block')) return;
    try { await api('PATCH', `/api/admin/licenses/${lic.id}`, { status: 'blocked', block_reason: `Leaked (${filename})`.slice(0, 200) }); toast('License blocked'); status.textContent = 'Blocked'; status.className = 'chip blocked'; e.target.remove(); }
    catch (err) { toast(err.message, true); }
  } }, 'Block this license') : null;
  return card(h('div', { class: 'row spread' }, title(label), status), rows([
    ['Key', h('span', { class: 'keycell' }, lic.key)], ['Owner', lic.owner], ['Buyer email', lic.buyer_email], ['Product', lic.product_name],
    ['Created', when(lic.created_at)], ['Created from IP', lic.issued_ip ? h('span', { class: 'mono' }, lic.issued_ip) : ''], ['Block reason', lic.block_reason]]),
    lic.servers?.length ? h('div', null, h('div', { class: 'divider' }, `Servers (${lic.servers.length})`),
      h('table', null, h('tbody', null, lic.servers.map(s => h('tr', null, h('td', null, s.name || '—'), h('td', { class: 'mono' }, `${s.ip}${s.port ? ':' + s.port : ''}`), h('td', { class: 'muted' }, s.status), h('td', { class: 'faint' }, ago(s.last_seen))))))) : null,
    lic.downloads?.length > 1 ? h('div', null, h('div', { class: 'divider' }, `All downloads of this license (${lic.downloads.length})`),
      h('table', null, h('tbody', null, lic.downloads.map(x => h('tr', null, h('td', null, when(x.at)), h('td', { class: 'mono' }, x.ip)))))) : null,
    block ? h('div', { class: 'row', style: { marginTop: '14px' } }, block) : null);
}

// --- Off-site backups (Settings, site owner) ------------------------------------------------------------------------------
export async function offsiteCard() {
  let s; try { s = await api('GET', '/api/admin/offsite'); } catch { return null; }
  const line = (name, t) => h('div', { class: 'row spread', style: { padding: '8px 0', borderTop: '1px solid var(--line, #2a2a33)' } },
    h('b', null, name), t ? h('span', { class: 'muted', style: { fontSize: '14px', textAlign: 'right' } },
      t.last_error && (!t.last_ok || t.last_error_at > t.last_ok) ? h('span', { style: { color: 'var(--bad)' } }, `Failed ${ago(Math.floor(t.last_error_at / 1000))}: ${t.last_error}`)
        : t.last_ok ? `Last copy ${ago(Math.floor(t.last_ok / 1000))}` : 'No copy sent yet') : h('span', { class: 'chip idle' }, 'Not set up'));
  const btn = h('button', { class: 'btn primary', id: 'offsiteNow', disabled: !s.enabled, onclick: async () => {
    btn.disabled = true; btn.textContent = 'Sending...';
    try { const r = await api('POST', '/api/admin/offsite/run'); toast('Backup sent: ' + Object.entries(r.results).map(([k, v]) => `${k} ${v}`).join(', ')); }
    catch (e) { toast(e.message, true); }
    const fresh = await offsiteCard(); if (fresh) box.replaceWith(fresh);
  } }, 'Back up now');
  const box = card(title('Off-site backups'),
    lead('A copy of everything is sent elsewhere when something changed (checked every ' + s.every_minutes + ' minutes) and right before the server stops. If the disk is wiped (Render\'s free tier does that on every restart), LicenseX puts the latest copy from S3-style storage back by itself.'),
    !s.enabled ? h('div', { class: 'notice warn' }, h('span', null, h('b', null, 'Not set up. '), 'Set LICENSEX_BACKUP_S3_* (Backblaze B2, Cloudflare R2, Amazon S3) and/or LICENSEX_BACKUP_DISCORD_WEBHOOK on your host. Steps: docs/BACKUPS.md')) : null,
    s.blocked ? h('div', { class: 'notice bad' }, h('span', null, h('b', null, 'Automatic backups are paused. '), `The copy could not be restored at startup (${s.restored?.error}). They resume when you press Back up now, which replaces the off-site copy with what is here.`)) : null,
    s.restored?.ok ? h('div', { class: 'notice ok' }, `Restored from the off-site copy when the server started (${s.restored.products} plugin file(s)).`) : null,
    s.discord_invalid ? h('div', { class: 'notice warn' }, 'LICENSEX_BACKUP_DISCORD_WEBHOOK is not a Discord webhook address.') : null,
    s.s3_incomplete ? h('div', { class: 'notice warn' }, 'S3 storage is only partly set up: it needs the endpoint, bucket, access key and secret key.') : null,
    line(s.s3 ? `Storage: ${s.s3.target}` : 'S3-style storage', s.s3), line('Discord channel', s.discord),
    h('p', { class: 'hint' }, s.encrypted ? 'Copies are encrypted with your backup password.' : 'Copies are not encrypted. Set LICENSEX_BACKUP_PASSWORD to encrypt them (they contain every license key).'),
    h('div', { class: 'row' }, btn));
  return box;
}
