// Drives the real admin UI in Chromium: logs in through the form, opens every page, and fails on any script error.
// Needs Playwright + Chromium (not an npm dependency of LicenseX):  npm run test:ui
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright  (default: the one preinstalled at /opt/node-tools)
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, oauthEnv, googleUser, signIn, signInRaw } from './helpers/oauth-mock.mjs';
import { totp, base32Decode } from '../server/twofa.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright/index.mjs').catch(() => import('playwright'));
const mock = await startMock();
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-ui-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'ui-pass';
process.env.LICENSEX_ADMIN_EMAILS = 'boss@example.com';
Object.assign(process.env, oauthEnv(mock.base));
const { server } = await import('../server/index.js');
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const problems = [];
async function newPage(context, label) {
  const page = await context.newPage();
  page.on('pageerror', e => problems.push(`${label}: script error: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|fonts\.g|status of 4\d\d/.test(m.text())) problems.push(`${label}: console: ${m.text()}`); });
  return page;
}
async function walk(page, label, expected) {
  await page.waitForSelector('nav a', { timeout: 5000 });
  const pages = await page.$$eval('nav a', as => as.map(a => a.dataset.page));
  assert.deepEqual(pages, expected, `${label}: sidebar pages`);
  let previous = '';
  for (const p of pages) {
    await page.evaluate(h => { location.hash = h; }, p);
    // a page is drawn once #view shows a heading different from the previous page's (the old heading would satisfy a plain selector)
    await page.waitForFunction(prev => { const t = document.querySelector('#view h1')?.innerText.trim(); return !!t && t !== prev; }, previous, { timeout: 8000 });
    previous = await page.evaluate(() => document.querySelector('#view h1').innerText.trim());
    const text = await page.$eval('#view', v => v.innerText);
    assert.ok(text.trim().length > 10, `${label}/${p}: page is empty`);
    assert.ok(!/\b(undefined|null|\[object Object\])\b/.test(text), `${label}/${p}: shows a raw value: ${text.match(/.{0,30}\b(undefined|null|\[object Object\])\b.{0,30}/)?.[0]}`);
  }
}

try {
  // 1. the owner, with the password, through the form (this path once left the page blank until a reload)
  const owner = await browser.newContext();
  const a = await newPage(owner, 'owner');
  await a.goto(base + '/admin');
  await a.fill('#pw', 'ui-pass');
  await a.click('#loginForm button');
  await walk(a, 'owner', ['overview', 'licenses', 'servers', 'leaks', 'products', 'build', 'groups', 'team', 'customers', 'plans', 'settings', 'audit', 'security']);
  await a.reload(); // a fresh load with the saved session works as well
  await walk(a, 'owner(reload)', ['overview', 'licenses', 'servers', 'leaks', 'products', 'build', 'groups', 'team', 'customers', 'plans', 'settings', 'audit', 'security']);

  // 1b. two-factor: set it up on the Security page (QR code + key), then the password form asks for the code
  await a.evaluate(() => { location.hash = 'overview'; });
  await a.evaluate(() => { location.hash = 'security'; });
  await a.click('#tfaSetup');
  await a.waitForSelector('#tfaSecret');
  assert.ok(await a.$('#view svg path'), 'a QR code is drawn');
  const secret = await a.inputValue('#tfaSecret');
  const code = (o = 0) => totp(base32Decode(secret), Math.floor(Date.now() / 30000) + o);
  await a.fill('#tfaCode', code());
  await a.click('#tfaEnable');
  await a.waitForFunction(() => /Save these recovery codes/.test(document.querySelector('#view').innerText));
  await a.reload();
  await a.waitForSelector('nav a');   // this browser stays signed in
  const fresh = await newPage(await browser.newContext(), 'owner-2fa');
  await fresh.goto(base + '/admin');
  await fresh.fill('#pw', 'ui-pass');
  await fresh.click('#loginForm button');
  await fresh.waitForSelector('#codeField:not([hidden])');
  await fresh.fill('#code', code(1));
  await fresh.click('#loginForm button');
  await fresh.waitForSelector('nav a');
  // and the leak tracer page takes a file
  await fresh.evaluate(() => { location.hash = 'leaks'; });
  await fresh.waitForSelector('#leakFile', { state: 'attached' });
  await fresh.setInputFiles('#leakFile', { name: 'x.jar', mimeType: 'application/java-archive', buffer: Buffer.from('not a jar') });
  await fresh.waitForFunction(() => /not a \.jar/.test(document.querySelector('#view').innerText));

  // 2. a customer with their own workspace, signed in through the (fake) provider
  const cookie = await signIn(base, mock, googleUser('dev@studio.io'));
  const cust = await browser.newContext();
  await cust.addCookies([{ name: 'lx_user', value: cookie.split('=').slice(1).join('='), url: base }]);
  const b = await newPage(cust, 'customer');
  await b.goto(base + '/dashboard');
  await walk(b, 'customer', ['overview', 'licenses', 'servers', 'leaks', 'products', 'groups', 'team', 'billing', 'settings', 'audit', 'security']);

  // 2b. the Team page, and a limited team member who only gets the pages their role allows
  const api = (method, path, body, ck = cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: ck }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
  const prodA = await api('POST', '/api/admin/products', { name: 'Alpha plugin' }), prodB = await api('POST', '/api/admin/products', { name: 'Beta plugin' });
  await api('POST', '/api/admin/licenses', { owner: 'alpha-buyer', product_id: prodA.id }); await api('POST', '/api/admin/licenses', { owner: 'beta-buyer', product_id: prodB.id });
  const roles = (await api('GET', '/api/admin/team')).roles;
  await api('POST', '/api/admin/team/members', { email: 'help@studio.io', role_id: roles.find(r => r.name === 'Support').id, all_products: false, product_ids: [prodA.id] });
  await b.goto(base + '/dashboard#team');
  await b.waitForFunction(() => document.querySelector('#view h1')?.innerText === 'Team' && /help@studio/.test(document.querySelector('#view').innerText));
  assert.match(await b.$eval('#view', v => v.innerText), /help@studio\.io[\s\S]*Support[\s\S]*Alpha plugin/, 'the team table lists the member with their role and product');
  await b.click('text=+ New role');
  await b.waitForSelector('dialog .perm-row');
  assert.ok((await b.$$('dialog .perm-row input')).length >= 10, 'the role editor lists the permissions');
  await b.click('dialog >> text=Cancel');
  await b.click('text=+ Add person');
  await b.waitForSelector('dialog #m-email');
  await b.click('dialog >> text=Only these products');
  assert.ok(await b.isVisible('dialog .perm-list'), 'picking "only these products" shows the product list');
  await b.click('dialog >> text=Cancel');

  const help = await browser.newContext();
  await help.addCookies([{ name: 'lx_user', value: (await signIn(base, mock, googleUser('help@studio.io'))).split('=').slice(1).join('='), url: base }]);
  const c = await newPage(help, 'member');
  await c.goto(base + '/dashboard');
  await walk(c, 'member', ['overview', 'licenses', 'servers', 'leaks', 'groups', 'security']);
  await c.evaluate(() => { location.hash = 'licenses'; });
  await c.waitForFunction(() => /alpha-buyer/.test(document.querySelector('#view').innerText));
  const seen = await c.$eval('#view', v => v.innerText);
  assert.match(seen, /alpha-buyer/); assert.doesNotMatch(seen, /beta-buyer/, 'a product-limited member never sees the other product\'s licenses');
  assert.match(await c.$eval('#view', v => v.innerText), /Alpha plugin/);
  assert.equal(await c.locator('text=+ New license').count(), 0, 'Support cannot create licenses, so there is no button');

  // 2c. a creator with two-factor on gets the code page after Google
  {
    const post = (path, body, c) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c }, body: JSON.stringify(body || {}) }).then(r => r.json());
    const ck = await signIn(base, mock, googleUser('two@studio.io'));
    await post('/api/workspace/ensure', null, ck);
    const { secret } = await post('/api/admin/2fa/setup', null, ck);
    await post('/api/admin/2fa/enable', { code: totp(base32Decode(secret), Math.floor(Date.now() / 30000)) }, ck);
    const raw = await signInRaw(base, mock, googleUser('two@studio.io'), '/dashboard');
    assert.equal(raw.location, '/login/2fa');
    const ctx2 = await browser.newContext();
    await ctx2.addCookies([{ name: 'lx_2fa', value: raw.cookies.lx_2fa, url: base }]);
    const d = await newPage(ctx2, 'two-factor');
    await d.goto(base + raw.location);
    await d.waitForSelector('#code');
    await d.fill('#code', '000000'); await d.click('#codeGo');
    await d.waitForFunction(() => /not right/.test(document.body.innerText));
    await d.fill('#code', totp(base32Decode(secret), Math.floor(Date.now() / 30000) + 1)); await d.click('#codeGo');
    await d.waitForURL(/\/dashboard$/);
    await d.waitForSelector('nav a');
  }

  // 3. the public pages
  const pub = await newPage(await browser.newContext(), 'public');
  for (const path of ['/', '/pricing', '/login']) { await pub.goto(base + path); await pub.waitForLoadState('networkidle'); }

  // 3b. plans are bought on BuiltByBit: the pricing page links there, and the dashboard has the key form
  const adminCookie = (await owner.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
  const plans = await api('GET', '/api/admin/plans', null, adminCookie);
  for (const [key, rid] of [['pro', '7001'], ['lifetime', '7002']]) await api('PATCH', `/api/admin/plans/${key}`, { ...plans.find(p => p.key === key), buy_url: `https://builtbybit.com/resources/${key}.${rid}/`, bbb_resource_id: rid }, adminCookie);
  await pub.goto(base + '/pricing');
  await pub.waitForSelector('a:has-text("on BuiltByBit")');
  assert.deepEqual(await pub.$$eval('a:has-text("on BuiltByBit")', as => as.map(a => a.getAttribute('href'))), ['https://builtbybit.com/resources/pro.7001/', 'https://builtbybit.com/resources/lifetime.7002/']);
  assert.match(await pub.$eval('#payNote', n => n.textContent), /bought on BuiltByBit/);
  await b.goto(base + '/dashboard#billing');
  await b.waitForSelector('#redeem-key');
  assert.match(await b.$eval('#view', v => v.innerText), /Activate a key[\s\S]*Plans[\s\S]*BuiltByBit/);
  await b.fill('#redeem-key', 'LX-AAAA-BBBB-CCCC-DDDD'); await b.click('#view button:has-text("Activate")');
  await b.waitForSelector('.toast.err');
  assert.match(await b.$eval('.toast.err', n => n.textContent), /not a valid access key/);

  await buyerFlows();   // sign-in pages, buyer portal, redirects (defined at the end of the file)

  assert.deepEqual(problems, [], 'no script errors anywhere');
  console.log('ui smoke: ok');
} finally {
  await browser.close(); server.close(); mock.close();
}

// --- buyer accounts: the three sign-in pages, the buyer portal and the redirects --------------------------------------
async function buyerFlows() {
  const call = (method, path, body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
  const withCookie = async (cookie, viewport) => {
    const ctx = await browser.newContext(viewport ? { viewport } : {});
    if (cookie) await ctx.addCookies([{ name: 'lx_user', value: cookie.split('=').slice(1).join('='), url: base }]);
    return ctx;
  };
  const owner = await signIn(base, mock, googleUser('boss@example.com'));
  const lic = await call('POST', '/api/admin/licenses', { owner: 'Pat Buyer', max_servers: 3 }, owner);
  for (const [id, name] of [['u1', 'Survival'], ['u2', 'Creative']]) await call('POST', '/api/v1/validate', { key: lic.key, instanceId: id, name, port: 25565 });
  const check = (id) => call('POST', '/api/v1/validate', { key: lic.key, instanceId: id, name: 'x', port: 25565 });

  // 1. the three sign-in pages
  const pub = await newPage(await withCookie(null), 'login pages');
  await pub.goto(base + '/login');
  await pub.waitForSelector('#pickCreator');
  let text = await pub.innerText('body');
  for (const copy of ["I'm a creator", 'I make Minecraft plugins', "I'm a buyer", 'I bought a plugin', 'See my licenses and servers'])
    assert.ok(text.includes(copy), `chooser says "${copy}"`);
  assert.equal(await pub.getAttribute('#pickCreator', 'href'), '/login/creator');
  assert.equal(await pub.getAttribute('#pickBuyer', 'href'), '/login/buyer');
  assert.equal(await pub.locator('.oauth-btn').count(), 0, 'the chooser has no provider buttons, it only asks who you are');

  await pub.goto(base + '/login/creator');
  await pub.waitForSelector('.oauth-btn');
  text = await pub.innerText('body');
  assert.ok(text.includes('Creator sign in') && text.includes('creates your free workspace'), 'creator copy');
  assert.deepEqual(await pub.$$eval('.oauth-btn', as => as.map(a => a.getAttribute('href'))), ['google', 'discord', 'github'].map(p => `/auth/${p}?next=%2Fdashboard`));
  await pub.goto(base + '/login/creator?next=/pricing');
  await pub.waitForSelector('.oauth-btn');
  assert.ok((await pub.getAttribute('.oauth-btn', 'href')).endsWith('next=%2Fpricing'), 'the pricing page can send creators back to it');
  await pub.goto(base + '/login?next=/dashboard');
  await pub.waitForSelector('.oauth-btn');
  assert.ok((await pub.innerText('body')).includes('Creator sign in'), 'old /login?next=/dashboard links still reach the creator sign-in');

  await pub.goto(base + '/login/buyer');
  await pub.waitForSelector('.oauth-btn');
  text = await pub.innerText('body');
  assert.ok(text.includes('Buyer sign in') && text.includes('see all your licenses'), 'buyer copy');
  assert.ok(!text.includes('creates your free workspace'), 'the buyer page does not talk about workspaces');
  assert.deepEqual(await pub.$$eval('.oauth-btn', as => as.map(a => a.getAttribute('href'))), ['google', 'discord', 'github'].map(p => `/auth/${p}?next=%2Faccount`));
  assert.equal(await pub.getAttribute('#keyLookup', 'href'), '/', 'buyers who want no account can still look up a key');
  await pub.goto(base + '/login/buyer?error=denied');
  await pub.waitForSelector('.err');
  assert.ok((await pub.innerText('.err')).includes('cancelled'), 'error codes show up');

  // a provider failure lands on /login; the message is shown on the page the visitor started from (here: the provider hop is made to fail)
  await pub.route('**/auth/google?*', route => route.fulfill({ status: 302, headers: { Location: '/login?error=denied' } }));
  await pub.goto(base + '/login/buyer');
  await pub.click('.oauth-btn:has-text("Google")');
  await pub.waitForURL('**/login/buyer?error=denied*');
  assert.ok((await pub.innerText('.err')).includes('cancelled'), 'a failed buyer sign-in reports on the buyer page');
  await pub.goto(base + '/login/creator');
  await pub.click('.oauth-btn:has-text("Google")');
  await pub.waitForURL('**/login/creator?error=denied*');
  await pub.unroute('**/auth/google?*');

  // not signed in: the portal sends you to the buyer sign-in; the home and pricing pages offer Sign in / creator sign-up
  await pub.goto(base + '/account');
  await pub.waitForURL('**/login/buyer');
  await pub.goto(base + '/');
  await pub.waitForSelector('nav.top a.pill');
  assert.equal(await pub.getAttribute('nav.top a.pill', 'href'), '/login');
  await pub.goto(base + '/pricing');
  await pub.waitForSelector('.plan');
  assert.equal(await pub.getAttribute('#ctaBtn', 'href'), '/login/creator');
  const planLinks = await pub.$$eval('.plan a.btn', as => as.map(a => a.getAttribute('href')));
  assert.equal(planLinks[0], '/login/creator', 'the free plan leads through the creator sign-in');
  assert.ok(planLinks.slice(1).every(h => h.startsWith('https://builtbybit.com/')), 'the paid plans are bought on BuiltByBit');

  // 2. a buyer signs in through the page (real redirect flow against the fake provider) and lands on the portal
  const buyerCtx = await withCookie(null);
  const buyer = await newPage(buyerCtx, 'buyer');
  mock.as(googleUser('pat@buyers.io', { name: 'Pat Buyer' }));
  await buyer.goto(base + '/login/buyer');
  await buyer.click('.oauth-btn:has-text("Google")');
  await buyer.waitForURL('**/account');
  await buyer.waitForSelector('.state');
  assert.ok((await buyer.innerText('#list')).includes('No licenses yet'), 'a new account starts with a clear empty state');
  assert.ok((await buyer.innerText('header')).includes('Pat Buyer') && (await buyer.innerText('header')).includes('Sign out'));

  // add the key (lower case on purpose) and see the license, its product/developer and servers
  const seen = problems.length;
  await buyer.fill('#key', 'nope');
  await buyer.click('#addBtn');
  await buyer.waitForSelector('#addErr:not([hidden])');
  assert.ok((await buyer.innerText('#addErr')).includes('License not found'), 'a wrong key says so, inline');
  const miss = problems.findIndex((m, i) => i >= seen && /status of 404/.test(m));
  if (miss >= 0) problems.splice(miss, 1);   // the browser logs the 404 we just provoked on purpose
  await buyer.fill('#key', lic.key.toLowerCase());
  await buyer.click('#addBtn');
  await buyer.waitForSelector('article.lic');
  text = await buyer.innerText('article.lic');
  for (const part of [lic.key, 'Active', 'LicenseX', 'Survival', 'Creative', '2 of 3', 'Pat Buyer', '127.0.0.x']) assert.ok(text.includes(part), `license card shows ${part}`);
  assert.equal(await buyer.locator('article.lic .srv').count(), 2);
  assert.equal(await buyer.locator('article.lic button:has-text("Unlink")').count(), 1, 'key-linked licenses can be unlinked');

  // removing a server goes through the confirm dialog and really frees the slot
  const removed = (await buyer.innerText('article.lic .srv')).includes('Survival') ? 'u1' : 'u2';
  await buyer.locator('article.lic .srv button:has-text("Remove")').first().click();
  await buyer.waitForSelector('dialog[open]');
  await buyer.click('dialog button.danger');
  await buyer.waitForFunction(() => document.querySelectorAll('article.lic .srv').length === 1);
  assert.ok((await buyer.innerText('article.lic')).includes('1 of 3'));
  assert.equal((await check(removed)).code, 'SERVER_REMOVED', 'the plugin was told at its next check-in');
  assert.equal((await check(removed === 'u1' ? 'u2' : 'u1')).ok, true, 'the other server is untouched');
  // cancelling the dialog changes nothing
  await buyer.locator('article.lic .srv button:has-text("Remove")').click();
  await buyer.waitForSelector('dialog[open]');
  await buyer.click('dialog button:has-text("Cancel")');
  await buyer.waitForSelector('dialog', { state: 'detached' });
  assert.equal(await buyer.locator('article.lic .srv').count(), 1);

  // unlinking empties the list again, and the license (and its server) is still there
  await buyer.click('article.lic button:has-text("Unlink")');
  await buyer.waitForSelector('dialog[open]');
  await buyer.click('dialog button.primary');
  await buyer.waitForSelector('.state');
  assert.ok((await buyer.innerText('#list')).includes('No licenses yet'));
  assert.equal((await check(removed === 'u1' ? 'u2' : 'u1')).ok, true, 'unlinking does not touch the license');
  await buyer.fill('#key', lic.key);
  await buyer.click('#addBtn');
  await buyer.waitForSelector('article.lic');

  // signed in: the buyer sign-in goes straight to the portal; the chooser and the home page know who you are
  await buyer.goto(base + '/login/buyer');
  await buyer.waitForURL('**/account');
  await buyer.goto(base + '/login');
  await buyer.waitForSelector('.who');
  assert.ok((await buyer.innerText('.card')).includes('Pat Buyer') && (await buyer.innerText('.card')).includes('Sign out'));
  await buyer.goto(base + '/');
  await buyer.waitForSelector('nav.top a[href="/account"]');
  assert.equal(await buyer.locator('nav.top a[href="/dashboard"]').count(), 0, 'a buyer without a workspace gets no Dashboard button');
  await buyer.goto(base + '/pricing');
  await buyer.waitForSelector('nav.top a[href="/account"]');

  // 3. the same portal at phone width: no sideways scrolling anywhere
  const phone = await newPage(await withCookie(await signIn(base, mock, googleUser('pat@buyers.io')), { width: 375, height: 760 }), 'phone');
  for (const path of ['/account', '/login', '/login/buyer', '/login/creator']) {
    await phone.goto(base + path);
    await phone.waitForLoadState('networkidle');
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${path} fits a 375px screen`);
    if (path === '/account') assert.equal(await phone.locator('article.lic').count(), 1);
  }

  // 4. creators: the creator sign-in sends a signed-in visitor to the dashboard (or the page they came for)
  const maker = await newPage(await withCookie(await signIn(base, mock, googleUser('maker@studio.io'))), 'maker');
  await maker.goto(base + '/login/creator');
  await maker.waitForURL('**/dashboard');
  await maker.waitForSelector('nav a');
  await maker.goto(base + '/login/creator?next=/pricing');
  await maker.waitForURL('**/pricing');
  await maker.goto(base + '/login/buyer');
  await maker.waitForURL('**/account');
  await maker.waitForSelector('.state');
  assert.equal(await maker.locator('article.lic').count(), 0, 'a creator\'s own workspace licenses are not in her buyer list');
  assert.ok((await maker.locator('nav.top a[href="/dashboard"]').count()) === 1, 'the portal links a creator to the dashboard');
}
