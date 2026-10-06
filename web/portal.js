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
try { const k = sessionStorage.getItem(KEY); if (k) { keyEl.value = k; lookup(k, { silent: true }); } } catch {}
