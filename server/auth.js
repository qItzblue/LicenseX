// "Sign in with Google / Discord / GitHub" (OAuth 2.0 authorization-code flow), no dependencies.
// A user only counts as an admin when a *verified* email of theirs is on the admin list.

const TIMEOUT = () => AbortSignal.timeout(10000);

/** Provider endpoints. LICENSEX_OAUTH_TEST_BASE swaps every provider for a local fake (used by the tests only). */
export function providerDefs(testBase) {
  if (testBase) {
    const b = testBase.replace(/\/+$/, '');
    return Object.fromEntries(['google', 'discord', 'github'].map(p => [p, {
      label: p[0].toUpperCase() + p.slice(1), scope: 'x', authUrl: `${b}/${p}/authorize`, tokenUrl: `${b}/${p}/token`, userUrl: `${b}/${p}/user`, emailsUrl: `${b}/${p}/emails`,
    }]));
  }
  return {
    google: { label: 'Google', scope: 'openid email profile', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token', userUrl: 'https://openidconnect.googleapis.com/v1/userinfo' },
    discord: { label: 'Discord', scope: 'identify email', authUrl: 'https://discord.com/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/oauth2/token', userUrl: 'https://discord.com/api/users/@me' },
    github: { label: 'GitHub', scope: 'read:user user:email', authUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token', userUrl: 'https://api.github.com/user', emailsUrl: 'https://api.github.com/user/emails' },
  };
}

export const normEmail = e => String(e ?? '').trim().toLowerCase();
export const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** Splits "a@x.com, b@y.com\nc@z.com" into a clean, de-duplicated, lower-cased list. */
export function parseEmails(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/);
  return [...new Set(raw.map(normEmail).filter(Boolean))];
}

export function authorizeUrl(def, { clientId, redirectUri, state }) {
  const u = new URL(def.authUrl);
  u.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: def.scope, state }).toString();
  return u.href;
}

async function json(res, what) {
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok || !data) throw new Error(`${what} failed (HTTP ${res.status})`);
  return data;
}

/** Exchanges the one-time code for an access token. */
export async function exchangeCode(def, { clientId, clientSecret, redirectUri, code }) {
  const res = await fetch(def.tokenUrl, {
    method: 'POST', signal: TIMEOUT(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'LicenseX' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret }),
  });
  const data = await json(res, 'Token exchange');
  if (!data.access_token) throw new Error(data.error_description || data.error || 'No access token returned');
  return data.access_token;
}

/**
 * Normalised profile: { id, name, avatar, emails: [verified emails only], email: primary verified or '' }.
 * Unverified emails are dropped on purpose: anyone can type any address into some providers.
 */
export async function fetchProfile(provider, def, token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'LicenseX' };
  const get = async (url, what) => json(await fetch(url, { headers, signal: TIMEOUT() }), what);

  if (provider === 'google') {
    const u = await get(def.userUrl, 'Google profile');
    const emails = u.email && (u.email_verified === true || u.email_verified === 'true') ? [normEmail(u.email)] : [];
    return { id: String(u.sub || ''), name: u.name || u.email || 'Google user', avatar: u.picture || '', emails, email: emails[0] || '' };
  }
  if (provider === 'discord') {
    const u = await get(def.userUrl, 'Discord profile');
    const emails = u.email && u.verified === true ? [normEmail(u.email)] : [];
    const avatar = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : '';
    return { id: String(u.id || ''), name: u.global_name || u.username || 'Discord user', avatar, emails, email: emails[0] || '' };
  }
  if (provider === 'github') {
    const u = await get(def.userUrl, 'GitHub profile');
    let list = [];
    try { list = await get(def.emailsUrl, 'GitHub emails'); } catch { /* no user:email scope or none: treated as no verified email */ }
    const verified = (Array.isArray(list) ? list : []).filter(e => e && e.verified === true && e.email);
    const primary = verified.find(e => e.primary) || verified[0];
    return { id: String(u.id || ''), name: u.name || u.login || 'GitHub user', avatar: u.avatar_url || '',
      emails: verified.map(e => normEmail(e.email)), email: primary ? normEmail(primary.email) : '' };
  }
  throw new Error('Unknown provider');
}
