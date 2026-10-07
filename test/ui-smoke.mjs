// Drives the real admin UI in Chromium: logs in through the form, opens every page, and fails on any script error.
// Needs Playwright + Chromium (not an npm dependency of LicenseX):  npm run test:ui
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright  (default: the one preinstalled at /opt/node-tools)
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, oauthEnv, googleUser, signIn } from './helpers/oauth-mock.mjs';

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
  page.on('console', m => { if (m.type() === 'error' && !/favicon|fonts\.g|status of 401/.test(m.text())) problems.push(`${label}: console: ${m.text()}`); });
  return page;
}
async function walk(page, label, expected) {
  await page.waitForSelector('nav a', { timeout: 5000 });
  const pages = await page.$$eval('nav a', as => as.map(a => a.dataset.page));
  assert.deepEqual(pages, expected, `${label}: sidebar pages`);
  for (const p of pages) {
    await page.evaluate(h => { location.hash = h; }, p);
    await page.waitForFunction(h => document.querySelector('nav a.on')?.dataset.page === h, p);
    await page.waitForSelector('#view h1', { timeout: 5000 });
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
  await walk(a, 'owner', ['overview', 'licenses', 'servers', 'products', 'build', 'groups', 'customers', 'plans', 'settings', 'audit']);
  await a.reload(); // a fresh load with the saved session works as well
  await walk(a, 'owner(reload)', ['overview', 'licenses', 'servers', 'products', 'build', 'groups', 'customers', 'plans', 'settings', 'audit']);

  // 2. a customer with their own workspace, signed in through the (fake) provider
  const cookie = await signIn(base, mock, googleUser('dev@studio.io'));
  const cust = await browser.newContext();
  await cust.addCookies([{ name: 'lx_user', value: cookie.split('=').slice(1).join('='), url: base }]);
  const b = await newPage(cust, 'customer');
  await b.goto(base + '/dashboard');
  await walk(b, 'customer', ['overview', 'licenses', 'servers', 'products', 'groups', 'billing', 'settings', 'audit']);

  // 3. the public pages
  const pub = await newPage(await browser.newContext(), 'public');
  for (const path of ['/', '/pricing', '/login']) { await pub.goto(base + path); await pub.waitForLoadState('networkidle'); }

  assert.deepEqual(problems, [], 'no script errors anywhere');
  console.log('ui smoke: ok');
} finally {
  await browser.close(); server.close(); mock.close();
}
