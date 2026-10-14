import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, oauthEnv, googleUser, signIn, signInRaw } from './helpers/oauth-mock.mjs';
import { totp, verifyTotp, base32Encode, base32Decode } from '../server/twofa.js';
import { readEntry, injectFiles, setZipComment, readZipComment, listEntries } from '../server/jarstamp.js';

// Two-factor sign-in and the leak tracer, through the real HTTP server.
const mock = await startMock();
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-security-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_ADMIN_EMAILS = 'boss@example.com';
process.env.LICENSEX_SIGNUPS_PER_IP_HOUR = '1000';
process.env.TRUST_PROXY = '1';
Object.assign(process.env, oauthEnv(mock.base));
const { server } = await import('../server/index.js');
let base, ipSeq = 0;
after(() => { server.close(); mock.close(); });
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));

// every request from its own address, so the per-address limits never get in the way of the tests themselves
const call = (method, path, body, cookie, headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.7.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})), cookies: Object.fromEntries(r.headers.getSetCookie().map(c => c.split(';')[0].split(/=(.*)/s).slice(0, 2))) }));
const codeFor = (secret, offset = 0) => totp(base32Decode(secret), Math.floor(Date.now() / 30000) + offset);
const passwordLogin = async (extra = {}) => { const r = await call('POST', '/api/admin/login', { password: 'pw', ...extra }); return { ...r, cookie: r.cookies.lx_admin ? 'lx_admin=' + r.cookies.lx_admin : null }; };

test('TOTP matches the RFC 6238 test vectors', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(totp(secret, Math.floor(59 / 30)), '287082');          // 94287082
  assert.equal(totp(secret, Math.floor(1111111109 / 30)), '081804');  // 07081804
  assert.equal(totp(secret, Math.floor(2000000000 / 30)), '279037');  // 69279037
  assert.deepEqual(base32Decode(base32Encode(secret)), secret);
  const b32 = base32Encode(secret);
  assert.equal(verifyTotp(b32, '081804', 0, 1111111109 * 1000), Math.floor(1111111109 / 30));
  assert.equal(verifyTotp(b32, '081804', Math.floor(1111111109 / 30), 1111111109 * 1000), 0, 'a used step is not accepted again');
  assert.equal(verifyTotp(b32, '000000', 0, 1111111109 * 1000), 0);
});

test('admin password: turning on two-factor signs out old sessions and every new sign-in needs a code', async () => {
  const first = await passwordLogin(), other = await passwordLogin();
  assert.ok(first.cookie && other.cookie);
  const setup = await call('POST', '/api/admin/2fa/setup', null, first.cookie);
  assert.equal(setup.status, 200); assert.match(setup.body.uri, /^otpauth:\/\/totp\//);
  assert.equal((await call('POST', '/api/admin/2fa/enable', { code: '000000' }, first.cookie)).status, 400, 'a wrong code does not turn it on');
  assert.equal((await call('GET', '/api/admin/me', null, other.cookie)).status, 200, 'still off: other sessions keep working');
  const on = await call('POST', '/api/admin/2fa/enable', { code: codeFor(setup.body.secret) }, first.cookie);
  assert.equal(on.status, 200); assert.equal(on.body.recovery_codes.length, 8);
  const mine = 'lx_admin=' + on.cookies.lx_admin;
  assert.equal((await call('GET', '/api/admin/me', null, mine)).status, 200, 'the session that turned it on keeps working');
  assert.equal((await call('GET', '/api/admin/me', null, other.cookie)).status, 401, 'every other session is signed out');
  assert.equal((await call('GET', '/api/admin/me', null, first.cookie)).status, 401, 'including the old cookie of this browser');
  assert.equal((await call('POST', '/api/admin/2fa/setup', null, mine)).status, 409, 'cannot be replaced without switching it off');

  const noCode = await passwordLogin();
  assert.equal(noCode.status, 401); assert.equal(noCode.body.code, '2FA_REQUIRED'); assert.equal(noCode.cookie, null);
  assert.equal((await passwordLogin({ code: '123456' })).body.code, '2FA_WRONG');
  assert.equal((await call('POST', '/api/admin/login', { password: 'nope', code: codeFor(setup.body.secret, 1) })).status, 401, 'the code does not replace the password');
  // the enable step used the current code: the next one (clock drift window) still works once, then never again
  const next = codeFor(setup.body.secret, 1);
  const ok = await passwordLogin({ code: next });
  assert.equal(ok.status, 200); assert.ok(ok.cookie);
  assert.equal((await call('GET', '/api/admin/me', null, ok.cookie)).status, 200);
  assert.equal((await passwordLogin({ code: next })).body.code, '2FA_WRONG', 'a code works only once');
  // recovery codes: once each, any formatting
  const rc = on.body.recovery_codes[0];
  assert.equal((await passwordLogin({ code: rc.toUpperCase().replace('-', ' ') })).status, 200);
  assert.equal((await passwordLogin({ code: rc })).status, 401, 'a recovery code works once');
  const st = await call('GET', '/api/admin/2fa', null, mine);
  assert.deepEqual([st.body.enabled, st.body.recovery_left], [true, 7]);
  // switching off needs a code too
  assert.equal((await call('POST', '/api/admin/2fa/disable', { code: '' }, mine)).status, 400);
  assert.equal((await call('POST', '/api/admin/2fa/disable', { code: on.body.recovery_codes[1] }, mine)).status, 200);
  assert.ok((await passwordLogin()).cookie, 'off again: the password alone works');
});

test('Google/Discord/GitHub sign-in asks for the code before giving a session', async () => {
  const person = googleUser('carol@shop.io');
  const cookie = await signIn(base, mock, person);
  await call('POST', '/api/workspace/ensure', null, cookie);
  const setup = await call('POST', '/api/admin/2fa/setup', null, cookie);
  assert.match(setup.body.uri, /carol%40shop\.io/);
  const on = await call('POST', '/api/admin/2fa/enable', { code: codeFor(setup.body.secret) }, cookie);
  assert.equal(on.status, 200);
  assert.equal((await call('GET', '/api/admin/me', null, cookie)).status, 401, 'the session from before is no longer enough');
  assert.equal((await call('GET', '/api/admin/me', null, 'lx_user=' + on.cookies.lx_user)).status, 200, 'the re-issued one is');
  assert.equal((await call('GET', '/api/account', null, cookie)).status, 401, 'buyer pages count the same session');

  const raw = await signInRaw(base, mock, person, '/dashboard');
  assert.equal(raw.location, '/login/2fa');
  assert.ok(!raw.cookies.lx_user && raw.cookies.lx_2fa, 'no session yet, only the pending step');
  const pending = 'lx_2fa=' + raw.cookies.lx_2fa;
  assert.equal((await call('GET', '/api/admin/me', null, pending)).status, 401);
  assert.equal((await call('GET', '/api/auth/me', null, pending)).body.twofa_pending, true);
  assert.equal((await call('POST', '/api/auth/2fa', { code: '000000' }, pending)).status, 401);
  assert.equal((await call('POST', '/api/auth/2fa', { code: '1' }, null)).body.code, '2FA_EXPIRED', 'nothing pending: nothing to finish');
  const done = await call('POST', '/api/auth/2fa', { code: codeFor(setup.body.secret, 1) }, pending);
  assert.equal(done.status, 200); assert.equal(done.body.next, '/dashboard');
  const session = 'lx_user=' + done.cookies.lx_user;
  assert.equal((await call('GET', '/api/admin/me', null, session)).body.email, 'carol@shop.io');

  // the site owner can switch it off for someone who is locked out
  const boss = await signIn(base, mock, googleUser('boss@example.com'));
  assert.equal((await call('POST', '/api/admin/2fa/reset', { email: 'carol@shop.io' }, session)).status, 403, 'customers cannot');
  assert.deepEqual((await call('POST', '/api/admin/2fa/reset', { email: 'Carol@Shop.io' }, boss)).body, { ok: true, was_on: true });
  assert.ok((await signInRaw(base, mock, person)).cookies.lx_user, 'signing in no longer asks for a code');
});

// --- leak tracer -----------------------------------------------------------------------------------------------------
const plugin = readFileSync(new URL('./fixtures/hello/hello-plugin.jar', import.meta.url));
const download = async (p, query) => Buffer.from(await (await fetch(`${base}/download/${p.slug}?token=${p.token}${query}`, { headers: { 'X-Forwarded-For': '203.0.113.' + (++ipSeq % 250), 'User-Agent': 'LeakerBrowser/1.0' } })).arrayBuffer());
const trace = (jar, cookie) => fetch(base + '/api/admin/leaks/trace', { method: 'POST', headers: { Cookie: cookie, 'X-Forwarded-For': '10.8.0.' + (++ipSeq % 250) }, body: jar }).then(async r => ({ status: r.status, body: await r.json() }));

test('the leak tracer finds whose copy a jar is, even when the key was swapped or removed', async () => {
  const dan = await signIn(base, mock, googleUser('dan@plugins.dev'));
  await call('POST', '/api/workspace/ensure', null, dan);
  const p = (await call('POST', '/api/admin/products', { name: 'Hello' }, dan)).body;
  await fetch(`${base}/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: dan, 'X-Filename': 'hello.jar' }, body: plugin });
  const leaked = await download(p, '&user=4242'), other = await download(p, '&user=777');
  const cfg = JSON.parse(readEntry(leaked, 'licensex.json').toString());
  assert.match(cfg.mark, /^[0-9a-f]{16}$/); assert.equal(readZipComment(leaked), cfg.mark, 'the mark is in two places');
  assert.notEqual(JSON.parse(readEntry(other, 'licensex.json').toString()).mark, cfg.mark, 'every download has its own mark');
  assert.ok(listEntries(leaked).includes('plugin.yml'), 'the jar is still a normal jar');

  const r = await trace(leaked, dan);
  assert.equal(r.status, 200); assert.equal(r.body.verdict, 'match');
  assert.equal(r.body.license.key, cfg.key);
  assert.match(r.body.download.ip, /^203\.0\.113\./); assert.equal(r.body.download.user_agent, 'LeakerBrowser/1.0'); assert.equal(r.body.download.bbb_user, '4242');

  // the leaker puts somebody else's key in: the mark still says whose copy it is
  const otherKey = JSON.parse(readEntry(other, 'licensex.json').toString()).key;
  const swapped = injectFiles(leaked, [{ name: 'licensex.json', content: JSON.stringify({ ...cfg, key: otherKey, mark: undefined }) }]);
  const s = (await trace(setZipComment(swapped, cfg.mark), dan)).body;
  assert.equal(s.verdict, 'key_swapped'); assert.equal(s.license.key, cfg.key); assert.equal(s.other_license.key, otherKey);
  // the config is removed entirely: the zip comment is enough
  const m = (await trace(setZipComment(injectFiles(leaked, [], { remove: n => n === 'licensex.json' }), cfg.mark), dan)).body;
  assert.equal(m.verdict, 'mark_only'); assert.equal(m.license.key, cfg.key);
  // marks stripped too: the key alone still finds the license
  assert.equal((await trace(setZipComment(injectFiles(leaked, [{ name: 'licensex.json', content: JSON.stringify({ ...cfg, mark: undefined }) }]), ''), dan)).body.verdict, 'key_only');
  // nothing left
  assert.equal((await trace(plugin, dan)).body.verdict, 'none');
  assert.equal((await trace(Buffer.from('not a jar'), dan)).status, 400);

  // another seller learns nothing about this jar
  const eve = await signIn(base, mock, googleUser('eve@else.dev'));
  await call('POST', '/api/workspace/ensure', null, eve);
  const e = (await trace(leaked, eve)).body;
  assert.deepEqual([e.verdict, e.license, e.download], ['none', null, null]);
  assert.equal((await trace(leaked, '')).status, 401);

  // blocking from the result works like anywhere else
  assert.equal((await call('PATCH', `/api/admin/licenses/${r.body.license.id}`, { status: 'blocked', block_reason: 'Leaked' }, dan)).status, 200);
  assert.equal((await call('POST', '/api/v1/validate', { key: cfg.key, instanceId: 'x' })).body.ok, false);
});

test('deleting a customer takes their download records along, so later backups still restore', async () => {
  const boss = await signIn(base, mock, googleUser('boss@example.com'));
  const fay = await signIn(base, mock, googleUser('fay@gone.dev'));
  const ws = (await call('POST', '/api/workspace/ensure', null, fay)).body.id;
  const p = (await call('POST', '/api/admin/products', { name: 'Gone' }, fay)).body;
  await fetch(`${base}/api/admin/products/${p.id}/file`, { method: 'POST', headers: { Cookie: fay, 'X-Filename': 'g.jar' }, body: plugin });
  await download(p, '&user=1');
  assert.equal((await call('DELETE', `/api/admin/customers/${ws}`, null, boss)).status, 200);
  const backup = Buffer.from(await (await fetch(base + '/api/admin/backup', { headers: { Cookie: boss } })).arrayBuffer());
  const r = await fetch(base + '/api/admin/restore', { method: 'POST', headers: { Cookie: boss }, body: backup });
  assert.equal(r.status, 200, JSON.stringify(await r.json()));
});
