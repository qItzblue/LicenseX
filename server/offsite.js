// Off-site backups: hosts like Render's free tier wipe the disk on every restart, so LicenseX keeps a copy of everything
// somewhere else and (for S3-style storage) puts it back by itself when it starts on an empty disk.
//
//  - S3-compatible storage (Amazon S3, Backblaze B2, Cloudflare R2, MinIO, ...): <prefix>latest.zip is replaced on every
//    backup, and <prefix>daily/<date>.zip keeps one copy per day. Restored automatically on an empty start.
//  - A Discord channel (webhook): the backup is posted as a file. Restore by hand (download it, Settings -> Restore).
//  - With a backup password every file is encrypted (AES-256-GCM) before it leaves the server.
//
// A backup is only sent when something changed. It is also sent when the server is told to stop (a deploy or restart),
// so the copy is as fresh as possible right before a wipe. Everything is configured with environment variables, because the
// database itself is what gets wiped.
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { injectFiles } from './jarstamp.js';

const MAGIC = Buffer.from('LXENC1\n');
const TIMEOUT = ms => AbortSignal.timeout(ms);
const sha256 = b => createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

// --- encryption -------------------------------------------------------------------------------------------------------
export const isEncrypted = buf => buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
export function encrypt(buf, password) {
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password, salt, 32);
  const c = createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}
export function decrypt(buf, password) {
  if (!password) throw new Error('This backup is encrypted. Set LICENSEX_BACKUP_PASSWORD to the password it was made with.');
  let o = MAGIC.length;
  const salt = buf.subarray(o, o += 16), iv = buf.subarray(o, o += 12), tag = buf.subarray(o, o += 16);
  const d = createDecipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(buf.subarray(o)), d.final()]); }
  catch { throw new Error('The backup password is wrong (or the file is damaged).'); }
}

// --- S3 (signature version 4) ---------------------------------------------------------------------------------------
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/** Signs a request the way S3 wants it (AWS Signature Version 4). Returns the headers to send. */
export function signS3({ method, url, headers = {}, body = Buffer.alloc(0), accessKey, secretKey, region, date = new Date(), payloadHash }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = amzDate.slice(0, 8);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash || sha256(body) };
  const names = Object.keys(h).sort();
  const query = [...u.searchParams].map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const path = u.pathname.split('/').map(p => enc(decodeURIComponent(p))).join('/');
  const canonical = [method, path, query, names.map(n => `${n}:${h[n]}\n`).join(''), names.join(';'), h['x-amz-content-sha256']].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  delete h.host;   // fetch sets it
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

function s3Target(c) {
  const endpoint = String(c.endpoint || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(endpoint) || !c.bucket || !c.accessKey || !c.secretKey) return null;
  // the region is in most endpoints (s3.eu-central-003.backblazeb2.com, s3.eu-west-1.amazonaws.com); R2 and others use "auto"
  const region = c.region || /s3[.-]([a-z0-9-]+)\.(?:backblazeb2|amazonaws)\.com/.exec(endpoint)?.[1] || (/amazonaws\.com/.test(endpoint) ? 'us-east-1' : 'auto');
  const prefix = String(c.prefix ?? 'licensex/').replace(/^\/+/, '');
  const objectUrl = key => `${endpoint}/${enc(c.bucket)}/${(prefix + key).split('/').map(enc).join('/')}`;
  const send = async (method, key, body) => {
    const url = objectUrl(key);
    const headers = signS3({ method, url, body: body || Buffer.alloc(0), accessKey: c.accessKey, secretKey: c.secretKey, region,
      headers: body ? { 'content-type': 'application/octet-stream' } : {} });
    return fetch(url, { method, headers, body, signal: TIMEOUT(120e3) });
  };
  return {
    label: `${c.bucket} at ${new URL(endpoint).host}${prefix ? ' (' + prefix + ')' : ''}`,
    async put(key, body) {
      const r = await send('PUT', key, body);
      if (!r.ok) throw new Error(`storage said ${r.status}: ${(await r.text()).slice(0, 200).replace(/\s+/g, ' ')}`);
    },
    async get(key) {
      const r = await send('GET', key);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`storage said ${r.status}: ${(await r.text()).slice(0, 200).replace(/\s+/g, ' ')}`);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

// --- Discord -----------------------------------------------------------------------------------------------------------
export const DISCORD_MAX = 9.5 * 1024 * 1024;   // webhooks take files up to 10 MB
async function discordPost(webhook, filename, file, text) {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: text, allowed_mentions: { parse: [] } }));
  form.append('files[0]', new Blob([file]), filename);
  const r = await fetch(webhook, { method: 'POST', body: form, signal: TIMEOUT(120e3) });
  if (!r.ok) throw new Error(`Discord said ${r.status}: ${(await r.text()).slice(0, 200).replace(/\s+/g, ' ')}`);
}

// --- the service ----------------------------------------------------------------------------------------------------
/** Reads the settings from environment variables (or the "backup" block of licensex.config.json). */
export function offsiteConfig(env = process.env, file = {}) {
  const f = file.backup || {}, s3 = f.s3 || {};
  const pick = (name, v) => env[name] ?? v;
  return {
    s3: { endpoint: pick('LICENSEX_BACKUP_S3_ENDPOINT', s3.endpoint), bucket: pick('LICENSEX_BACKUP_S3_BUCKET', s3.bucket), region: pick('LICENSEX_BACKUP_S3_REGION', s3.region),
      accessKey: pick('LICENSEX_BACKUP_S3_ACCESS_KEY', s3.accessKey), secretKey: pick('LICENSEX_BACKUP_S3_SECRET_KEY', s3.secretKey), prefix: pick('LICENSEX_BACKUP_S3_PREFIX', s3.prefix) },
    discord: pick('LICENSEX_BACKUP_DISCORD_WEBHOOK', f.discordWebhook) || '',
    password: pick('LICENSEX_BACKUP_PASSWORD', f.password) || '',
    everyMinutes: Math.max(5, Number(pick('LICENSEX_BACKUP_EVERY_MINUTES', f.everyMinutes)) || 60),
    discordEveryMinutes: Math.max(30, Number(pick('LICENSEX_BACKUP_DISCORD_EVERY_MINUTES', f.discordEveryMinutes)) || 360),
    restoreOnStart: String(pick('LICENSEX_BACKUP_RESTORE_ON_START', f.restoreOnStart ?? '1')) !== '0',
  };
}

/**
 * `snapshot()` returns { zip, digest, small }: the backup, a hash of its contents (to skip unchanged backups) and a
 * version without plugin files (for Discord's size limit).
 */
export function createOffsite({ config, snapshot, log = () => {}, now = () => Date.now(), anyWebhook = false }) {
  const s3 = s3Target(config.s3);
  const discord = anyWebhook ? config.discord : /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(config.discord) ? config.discord : '';
  const ext = config.password ? '.zip.enc' : '.zip';
  const seal = buf => (config.password ? encrypt(buf, config.password) : buf);
  const state = { s3: { last_ok: null, last_error: null, last_error_at: null, digest: null }, discord: { last_ok: null, last_error: null, last_error_at: null, digest: null, sent_at: 0 },
    restored: null, running: false };
  let timer = null;

  async function run({ force = false, reason = 'scheduled' } = {}) {
    if (!s3 && !discord) return { ok: false, message: 'No off-site backup is set up.' };
    if (state.running) return { ok: false, message: 'A backup is already running.' };
    state.running = true;
    const out = {};
    try {
      const snap = snapshot();
      if (s3 && (force || snap.digest !== state.s3.digest)) {
        try {
          const file = seal(snap.zip);
          await s3.put('latest' + ext, file);
          await s3.put(`daily/${new Date(now()).toISOString().slice(0, 10)}${ext}`, file);
          Object.assign(state.s3, { last_ok: now(), digest: snap.digest, last_error: null }); out.s3 = 'sent';
        } catch (e) { Object.assign(state.s3, { last_error: e.message, last_error_at: now() }); out.s3 = 'failed: ' + e.message; log('backup.offsite-fail', 's3', e.message); }
      } else if (s3) out.s3 = 'unchanged';
      const discordDue = force || reason === 'shutdown' || now() - state.discord.sent_at >= config.discordEveryMinutes * 60e3;
      if (discord && discordDue && (force || snap.digest !== state.discord.digest)) {
        try {
          let file = seal(snap.zip), note = '';
          if (file.length > DISCORD_MAX) { file = seal(snap.small); note = ' (without the plugin files: too big for Discord)'; }
          if (file.length > DISCORD_MAX) throw new Error('the backup is larger than Discord allows (10 MB). Use S3-style storage.');
          const stamp = new Date(now()).toISOString().replace(/[:]/g, '-').slice(0, 19);
          await discordPost(discord, `licensex-backup-${stamp}${ext}`, file, `LicenseX backup${note}${config.password ? ' (encrypted)' : ''} · ${reason}`);
          Object.assign(state.discord, { last_ok: now(), digest: snap.digest, sent_at: now(), last_error: null }); out.discord = 'sent' + note;
        } catch (e) { Object.assign(state.discord, { last_error: e.message, last_error_at: now() }); out.discord = 'failed: ' + e.message; log('backup.offsite-fail', 'discord', e.message); }
      } else if (discord) out.discord = discordDue ? 'unchanged' : 'not due yet';
      return { ok: !Object.values(out).some(v => v.startsWith('failed')), results: out };
    } finally { state.running = false; }
  }

  return {
    enabled: !!(s3 || discord),
    run,
    /** The newest backup in S3-style storage (decrypted), or null. */
    async fetchLatest() {
      if (!s3) return null;
      const buf = await s3.get('latest' + ext);
      if (!buf) return null;
      return isEncrypted(buf) ? decrypt(buf, config.password) : buf;
    },
    markRestored(info) { state.restored = { ...info, at: now() }; },
    start() {
      if (timer || !(s3 || discord)) return;
      timer = setInterval(() => run().catch(() => {}), config.everyMinutes * 60e3);
      timer.unref();
      setTimeout(() => run({ reason: 'startup' }).catch(() => {}), 60e3).unref();   // a first copy soon after starting
    },
    stop() { clearInterval(timer); timer = null; },
    status: () => ({
      enabled: !!(s3 || discord), encrypted: !!config.password, every_minutes: config.everyMinutes, discord_every_minutes: config.discordEveryMinutes,
      restore_on_start: config.restoreOnStart && !!s3,
      s3: s3 ? { target: s3.label, ...pickState(state.s3) } : null,
      discord: discord ? pickState(state.discord) : null,
      discord_invalid: !!config.discord && !discord,
      s3_incomplete: !s3 && !!(config.s3.endpoint || config.s3.bucket || config.s3.accessKey),
      restored: state.restored, running: state.running,
    }),
  };
}
const pickState = ({ last_ok, last_error, last_error_at }) => ({ last_ok, last_error, last_error_at });

/** A plain zip from the files of a backup minus the plugin files (Discord's size limit). */
export function withoutProducts(files) {
  return injectFiles(Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]), files.filter(f => !f.name.startsWith('products/')));
}
