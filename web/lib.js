// Tiny DOM + fetch helpers shared by both pages. No framework, no build step.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) el.style.setProperty(p, x);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}

/** The owner can look into a customer's workspace; the choice lives in this tab only. Customers' requests ignore it. */
export const currentWs = () => { try { return sessionStorage.getItem('lx-ws') || ''; } catch { return ''; } };
export const setWs = id => { try { id ? sessionStorage.setItem('lx-ws', String(id)) : sessionStorage.removeItem('lx-ws'); } catch {} };
export const wsHeaders = () => (currentWs() ? { 'X-Workspace': currentWs() } : {});
/** For plain links (downloads) that cannot send headers. */
export const wsq = path => (currentWs() ? path + (path.includes('?') ? '&' : '?') + 'ws=' + encodeURIComponent(currentWs()) : path);

export async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...wsHeaders() }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.message || `Request failed (${r.status})`), { status: r.status, data });
  return data;
}

export function toast(msg, err) {
  let host = document.querySelector('.toast-host');
  if (!host) document.body.append(host = h('div', { class: 'toast-host' }));
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  host.append(t); setTimeout(() => t.remove(), 3500);
}

export function confirmDialog(title, text, okLabel = 'Confirm', danger = true) {
  return new Promise(resolve => {
    const dlg = h('dialog', null,
      h('h3', null, title), h('p', { class: 'muted' }, text),
      h('div', { class: 'row', style: { 'justify-content': 'flex-end', 'margin-top': '20px' } },
        h('button', { class: 'btn', onclick: () => dlg.close('no') }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => dlg.close('yes') }, okLabel)));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'yes'); dlg.remove(); });
    document.body.append(dlg); dlg.showModal();
  });
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function ago(ts) {
  if (!ts) return 'never';
  const s = ts - Math.floor(Date.now() / 1000), a = Math.abs(s);
  if (a < 60) return 'just now';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
export const date = ts => ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
export const limitText = n => n === -1 ? '∞' : String(n);
export const copy = async text => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed', true); } };
