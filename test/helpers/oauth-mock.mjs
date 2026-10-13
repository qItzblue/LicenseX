// A fake Google/Discord/GitHub for tests, plus a "browser" that signs people in through the real redirect flow.
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

export async function startMock() {
  const state = { next: null };               // the person currently "at the provider"
  const codes = new Map();
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const [, provider, endpoint] = u.pathname.split('/');
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (endpoint === 'authorize') {
      const code = 'code-' + codes.size; codes.set(code, state.next);
      return send(302, {}, { Location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` });
    }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      if (endpoint === 'token') {
        const f = new URLSearchParams(body);
        if (f.get('client_id') !== `id-${provider}` || f.get('client_secret') !== `secret-${provider}` || !codes.has(f.get('code'))) return send(400, { error: 'invalid_grant' });
        return send(200, { access_token: 'tok-' + f.get('code') });
      }
      const p = codes.get((req.headers.authorization || '').replace('Bearer tok-', ''));
      if (!p) return send(401, { message: 'bad token' });
      return send(200, endpoint === 'emails' ? (p.emails || []) : p.user);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, as: profile => { state.next = profile; }, close: () => server.close() };
}

export function oauthEnv(mockBase) {
  const env = { LICENSEX_OAUTH_TEST_BASE: mockBase };
  for (const p of ['GOOGLE', 'DISCORD', 'GITHUB']) { env[`LICENSEX_${p}_CLIENT_ID`] = `id-${p.toLowerCase()}`; env[`LICENSEX_${p}_CLIENT_SECRET`] = `secret-${p.toLowerCase()}`; }
  return env;
}

export const googleUser = (email, { verified = true, name } = {}) => ({ user: { sub: 'g-' + email, email, email_verified: verified, name: name || email.split('@')[0], picture: '' } });

/** Signs `profile` in with Google through the real redirect flow. Returns the session cookie. */
export async function signIn(base, mock, profile) {
  const cookiesOf = res => Object.fromEntries(res.headers.getSetCookie().map(c => c.split(';')[0].split(/=(.*)/s).slice(0, 2)));
  mock.as(profile);
  const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const oauth = 'lx_oauth=' + cookiesOf(start).lx_oauth;
  const atProvider = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(atProvider.headers.get('location'));
  const done = await fetch(base + cb.pathname + cb.search, { redirect: 'manual', headers: { Cookie: oauth } });
  const c = cookiesOf(done);
  assert.ok(c.lx_user, 'sign-in should set a session cookie');
  return 'lx_user=' + c.lx_user;
}
