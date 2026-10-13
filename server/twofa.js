// Two-factor sign-in with an authenticator app (TOTP, RFC 6238: Google Authenticator, Authy, 1Password, Bitwarden, ...).
//
//  - Each account turns it on for itself: the admin password is one account ("password"), every signed-in email another.
//  - Once it is on, a sign-in only gives a session after the 6-digit code (or a one-time recovery code). Sessions that were
//    made without a code stop working at once, so turning it on also throws out anybody who stole a session earlier.
//  - Codes are accepted once (a code seen once cannot be replayed within its 30 seconds) and guessing is rate limited.
//  - The site owner can switch it off for someone who lost their phone and their recovery codes (or with LICENSEX_RESET_2FA).
import { createHmac, randomBytes, createHash } from 'node:crypto';

const STEP = 30, DIGITS = 6, WINDOW = 1;   // accept the previous, current and next 30-second code (clock drift)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const c of String(str).toUpperCase().replace(/[\s=-]/g, '')) {
    const i = B32.indexOf(c); if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** The code for one 30-second step. */
export function totp(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 10 ** DIGITS).padStart(DIGITS, '0');
}
const stepAt = ms => Math.floor(ms / 1000 / STEP);

/** The step the code belongs to (newer than `lastStep`), or 0 if it is wrong, too old or already used. */
export function verifyTotp(secretB32, code, lastStep = 0, ms = Date.now()) {
  if (!/^\d{6}$/.test(code)) return 0;
  const secret = base32Decode(secretB32), t = stepAt(ms);
  for (let s = t - WINDOW; s <= t + WINDOW; s++) if (s > lastStep && totp(secret, s) === code) return s;
  return 0;
}

const sha = s => createHash('sha256').update(s).digest('hex');
const cleanCode = c => String(c ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const newRecoveryCodes = () => Array.from({ length: 8 }, () => {
  const s = base32Encode(randomBytes(7)).toLowerCase().slice(0, 10);
  return `${s.slice(0, 5)}-${s.slice(5)}`;
});

export const subjectForEmail = e => 'email:' + String(e).toLowerCase();
export const PASSWORD_SUBJECT = 'password';

export function createTwoFactor(db) {
  const row = s => db.prepare('SELECT * FROM twofa WHERE subject = ?').get(s);
  const enabledSubjects = subjects => subjects.length
    ? db.prepare(`SELECT * FROM twofa WHERE enabled = 1 AND subject IN (${subjects.map(() => '?').join(',')})`).all(...subjects) : [];
  const tf = {
    row,
    /** Must this sign-in give a code? (any of the person's verified emails has two-factor on) */
    requiredFor: subjects => enabledSubjects(subjects).length > 0,
    emailSubjects: emails => (Array.isArray(emails) ? emails : []).map(subjectForEmail),
    /**
     * Checks a code against the account(s). A 6-digit code is a TOTP code; anything else is tried as a recovery code
     * (used up when it works). Returns the subject it matched, or null.
     */
    check(subjects, code) {
      const c = cleanCode(code);
      for (const r of enabledSubjects(subjects)) {
        if (/^\d{6}$/.test(c)) {
          const step = verifyTotp(r.secret, c, r.last_step);
          // the update only succeeds once per step, so the same code sent twice at the same moment still only counts once
          if (step && db.prepare('UPDATE twofa SET last_step = ? WHERE subject = ? AND last_step < ?').run(step, r.subject, step).changes) return r.subject;
        } else if (c.length === 10) {
          const left = JSON.parse(r.recovery || '[]'), h = sha(c);
          if (left.includes(h)) {
            const after = JSON.stringify(left.filter(x => x !== h));
            if (db.prepare('UPDATE twofa SET recovery = ? WHERE subject = ? AND recovery = ?').run(after, r.subject, r.recovery).changes) return r.subject;
          }
        }
      }
      return null;
    },
    /** Starts (or restarts) setting it up: a new secret that only counts once a code from it has been entered. */
    begin(subject) {
      if (row(subject)?.enabled) return null;
      const secret = base32Encode(randomBytes(20));
      db.prepare('INSERT INTO twofa (subject, secret, enabled, created_at) VALUES (?,?,0,?) ON CONFLICT(subject) DO UPDATE SET secret = excluded.secret, enabled = 0, last_step = 0, recovery = \'[]\', created_at = excluded.created_at')
        .run(subject, secret, Math.floor(Date.now() / 1000));
      return secret;
    },
    /** Finishes setting it up with a code from the app. Returns the recovery codes (shown once), or null if the code is wrong. */
    finish(subject, code) {
      const r = row(subject);
      if (!r || r.enabled) return null;
      const step = verifyTotp(r.secret, cleanCode(code), r.last_step);
      if (!step) return null;
      const codes = newRecoveryCodes();
      const done = db.prepare('UPDATE twofa SET enabled = 1, last_step = ?, recovery = ?, enabled_at = ? WHERE subject = ? AND enabled = 0')
        .run(step, JSON.stringify(codes.map(x => sha(cleanCode(x)))), Math.floor(Date.now() / 1000), subject);
      return done.changes ? codes : null;
    },
    newRecovery(subject) {
      const codes = newRecoveryCodes();
      db.prepare('UPDATE twofa SET recovery = ? WHERE subject = ? AND enabled = 1').run(JSON.stringify(codes.map(x => sha(cleanCode(x)))), subject);
      return codes;
    },
    remove: subject => db.prepare('DELETE FROM twofa WHERE subject = ?').run(subject).changes > 0,
    status(subject) {
      const r = row(subject);
      return { enabled: !!r?.enabled, recovery_left: r?.enabled ? JSON.parse(r.recovery || '[]').length : 0, since: r?.enabled_at || null };
    },
  };
  return tf;
}

/** otpauth:// link that authenticator apps read from the QR code. */
export const otpauthUri = ({ issuer, account, secret }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
