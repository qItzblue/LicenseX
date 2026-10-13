import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, oauthEnv, googleUser, signIn } from './helpers/oauth-mock.mjs';
import { verifySignature, formEncode } from '../server/billing.js';

// ---- fake Stripe API: records what we send and answers like Stripe
const stripeCalls = [];
const fakeStripe = createServer((req, res) => {
  let body = ''; req.on('data', d => body += d);
  req.on('end', () => {
    stripeCalls.push({ path: req.url, auth: req.headers.authorization, form: Object.fromEntries(new URLSearchParams(body)) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.test/c/cs_test_1' }));
    if (req.url === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ id: 'bps_1', url: 'https://billing.stripe.test/p/1' }));
    res.writeHead(404); res.end('{}');
  });
});
await new Promise(r => fakeStripe.listen(0, '127.0.0.1', r));
const mock = await startMock();

const WHSEC = 'whsec_test_secret';
process.env.LICENSEX_DATA = mkdtempSync(join(tmpdir(), 'lx-billing-'));
process.env.LICENSEX_ADMIN_PASSWORD = 'pw';
process.env.LICENSEX_ADMIN_EMAILS = 'boss@example.com';
process.env.LICENSEX_SIGNUPS_PER_IP_HOUR = '1000';
process.env.LICENSEX_STRIPE_SECRET_KEY = 'sk_test_abc123';
process.env.LICENSEX_STRIPE_WEBHOOK_SECRET = WHSEC;
process.env.LICENSEX_STRIPE_API_BASE = `http://127.0.0.1:${fakeStripe.address().port}`;
process.env.LICENSEX_PUBLIC_URL = 'https://licenses.example.test';
Object.assign(process.env, oauthEnv(mock.base));
const { server } = await import('../server/index.js');
let base, boss, alice, bob;
const nowSec = () => Math.floor(Date.now() / 1000);
after(() => { server.close(); mock.close(); fakeStripe.close(); });

const call = (method, path, body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const sign = (payload, { t = nowSec(), secret = WHSEC } = {}) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
let evSeq = 0;
const hook = (type, object, { signature, id } = {}) => {
  const payload = JSON.stringify({ id: id || `evt_${++evSeq}`, object: 'event', type, data: { object } });
  return fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature ?? sign(payload) }, body: payload })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
};
const ws = async cookie => (await call('GET', '/api/workspace', null, cookie)).body;
const MARK = { licensex: '1' };

before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  boss = await signIn(base, mock, googleUser('boss@example.com'));
  alice = await signIn(base, mock, googleUser('alice@devs.io'));
  bob = await signIn(base, mock, googleUser('bob@devs.io'));
});

test('signature check: Stripe scheme, tolerance, tampering, downgrade, constant inputs', () => {
  const raw = Buffer.from('{"id":"evt_1"}');
  const good = sign(raw.toString());
  assert.equal(verifySignature(raw, good, WHSEC), true);
  assert.equal(verifySignature(raw, good, 'whsec_other'), false);
  assert.equal(verifySignature(Buffer.from('{"id":"evt_2"}'), good, WHSEC), false, 'body must be byte-exact');
  assert.equal(verifySignature(raw, sign(raw.toString(), { t: nowSec() - 3600 }), WHSEC), false, 'old timestamps are replays');
  assert.equal(verifySignature(raw, sign(raw.toString(), { t: nowSec() + 3600 }), WHSEC), false);
  assert.equal(verifySignature(raw, good.replace('v1=', 'v0='), WHSEC), false, 'only v1 counts');
  assert.equal(verifySignature(raw, `t=${nowSec()},v1=zz`, WHSEC), false);
  assert.equal(verifySignature(raw, '', WHSEC), false);
  assert.equal(verifySignature(raw, good, ''), false);
  const t = nowSec(), v1 = createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
  assert.equal(verifySignature(raw, `t=${t},v1=deadbeef,v1=${v1}`, WHSEC), true, 'any matching v1 (secret rolling)');
  assert.equal(formEncode({ a: { b: 1 }, c: [{ d: 2 }, { d: 3 }], e: undefined }).toString(), 'a%5Bb%5D=1&c%5B0%5D%5Bd%5D=2&c%5B1%5D%5Bd%5D=3');
});

test('pricing: editable plans, payments on, and what the visitor currently has', async () => {
  const p = (await call('GET', '/api/public/pricing')).body;
  assert.deepEqual(p.plans.map(x => x.key), ['free', 'pro', 'lifetime']);
  assert.equal(p.payments, true);
  const pro = p.plans.find(x => x.key === 'pro');
  assert.equal(pro.price_cents, 900); assert.equal(pro.interval, 'month'); assert.equal(pro.highlight, true); assert.ok(pro.features.length >= 4);
  assert.equal(p.current, null);
  // the owner edits a plan: price, limits and bullets change on the public page; hidden plans disappear
  assert.equal((await call('PATCH', '/api/admin/plans/pro', { name: 'Pro', price_cents: 1200, interval: 'month', max_products: 12, max_licenses: 3000, features: 'Line one\nLine two' }, boss)).status, 200);
  assert.equal((await call('POST', '/api/admin/plans', { key: 'team', name: 'Team', price_cents: 4900, interval: 'year', max_products: -1, max_licenses: -1 }, boss)).status, 201);
  await call('PATCH', '/api/admin/plans/team', { active: false }, boss);
  const p2 = (await call('GET', '/api/public/pricing')).body;
  assert.equal(p2.plans.find(x => x.key === 'pro').price_cents, 1200); assert.deepEqual(p2.plans.find(x => x.key === 'pro').features, ['Line one', 'Line two']);
  assert.ok(!p2.plans.some(x => x.key === 'team'));
  assert.equal((await call('DELETE', '/api/admin/plans/free', null, boss)).status, 400);
  assert.equal((await call('POST', '/api/admin/plans', { key: 'BAD KEY', name: 'x', price_cents: 500, interval: 'month', max_products: 1, max_licenses: 1 }, boss)).status, 400);
  assert.equal((await call('POST', '/api/admin/plans', { key: 'cheap', name: 'x', price_cents: 5, interval: 'month', max_products: 1, max_licenses: 1 }, boss)).status, 400, 'Stripe minimum');
  assert.equal((await call('DELETE', '/api/admin/plans/team', null, boss)).status, 200);
  await call('PATCH', '/api/admin/plans/pro', { name: 'Pro', price_cents: 900, interval: 'month', max_products: 10, max_licenses: 2500, features: 'a\nb\nc\nd' }, boss);
});

test('checkout: subscription and one-time sessions are built correctly and tied to the right workspace', async () => {
  const w = (await call('POST', '/api/workspace/ensure', null, alice)).body;
  assert.equal((await call('POST', '/api/billing/checkout', { plan: 'pro' })).status, 401);
  assert.equal((await call('POST', '/api/billing/checkout', { plan: 'free' }, alice)).status, 400);
  assert.equal((await call('POST', '/api/billing/checkout', { plan: 'nonsense' }, alice)).status, 400);
  stripeCalls.length = 0;
  const r = await call('POST', '/api/billing/checkout', { plan: 'pro' }, alice);
  assert.equal(r.status, 200); assert.equal(r.body.url, 'https://checkout.stripe.test/c/cs_test_1');
  const c = stripeCalls[0];
  assert.equal(c.path, '/v1/checkout/sessions');
  assert.equal(c.auth, 'Basic ' + Buffer.from('sk_test_abc123:').toString('base64'));
  assert.equal(c.form.mode, 'subscription');
  assert.equal(c.form['line_items[0][price_data][unit_amount]'], '900');
  assert.equal(c.form['line_items[0][price_data][currency]'], 'usd');
  assert.equal(c.form['line_items[0][price_data][recurring][interval]'], 'month');
  assert.match(c.form['line_items[0][price_data][product_data][name]'], /Pro/);
  assert.equal(c.form['line_items[0][quantity]'], '1');
  assert.equal(c.form.client_reference_id, String(w.id)); assert.equal(c.form.customer_email, 'alice@devs.io');
  assert.equal(c.form['metadata[workspace_id]'], String(w.id)); assert.equal(c.form['metadata[plan_key]'], 'pro'); assert.equal(c.form['metadata[licensex]'], '1');
  assert.equal(c.form['subscription_data[metadata][workspace_id]'], String(w.id));
  assert.equal(c.form.success_url, 'https://licenses.example.test/dashboard?paid=1#billing'); assert.equal(c.form.cancel_url, 'https://licenses.example.test/pricing');

  stripeCalls.length = 0;
  await call('POST', '/api/billing/checkout', { plan: 'lifetime' }, alice);
  const l = stripeCalls[0].form;
  assert.equal(l.mode, 'payment'); assert.equal(l['line_items[0][price_data][unit_amount]'], '14900');
  assert.ok(!('line_items[0][price_data][recurring][interval]' in l), 'one-time has no recurrence');
  assert.equal(l['payment_intent_data[metadata][workspace_id]'], String(w.id));
});

test('webhook: unsigned, forged, replayed-too-old and malformed requests change nothing', async () => {
  const before = await ws(alice);
  const sub = { object: 'checkout.session', mode: 'subscription', customer: 'cus_X', subscription: 'sub_X', client_reference_id: String(before.id), metadata: { ...MARK, workspace_id: String(before.id), plan_key: 'pro' } };
  const payload = JSON.stringify({ id: 'evt_forged', type: 'checkout.session.completed', data: { object: sub } });
  const post = (headers, body = payload) => fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }).then(r => r.status);
  assert.equal(await post({}), 400, 'no signature');
  assert.equal(await post({ 'Stripe-Signature': 'garbage' }), 400);
  assert.equal(await post({ 'Stripe-Signature': sign(payload, { secret: 'whsec_attacker' }) }), 400, 'wrong secret');
  assert.equal(await post({ 'Stripe-Signature': sign(payload, { t: nowSec() - 7200 }) }), 400, 'old timestamp');
  assert.equal(await post({ 'Stripe-Signature': sign(payload) }, payload.replace('pro', 'lifetime')), 400, 'body altered after signing');
  const after = await ws(alice);
  assert.equal(after.plan_key, before.plan_key, 'still free'); assert.equal(after.plan.key, 'free');
  assert.equal((await call('GET', '/api/stripe/webhook')).status, 404);
});

test('subscription lifecycle: purchase, renewal, payment failure, cancel at period end, lapse', async () => {
  const w = await ws(alice), end1 = nowSec() + 30 * 86400;
  const completed = { object: 'checkout.session', mode: 'subscription', customer: 'cus_alice', subscription: 'sub_alice', payment_status: 'paid',
    client_reference_id: String(w.id), metadata: { ...MARK, workspace_id: String(w.id), plan_key: 'pro' } };
  assert.equal((await hook('checkout.session.completed', completed)).status, 200);
  let s = await ws(alice);
  assert.equal(s.plan.key, 'pro'); assert.equal(s.plan_status, 'active'); assert.equal(s.plan_source, 'stripe');
  assert.ok(s.plan_until > nowSec() + 28 * 86400, 'provisional period');
  assert.equal(s.billing.can_portal, true);
  assert.equal((await call('GET', '/api/public/pricing', null, alice)).body.current.plan_key, 'pro');

  // exact period end arrives (both API shapes: top-level and per item)
  await hook('customer.subscription.updated', { object: 'subscription', id: 'sub_alice', customer: 'cus_alice', status: 'active', current_period_end: end1, metadata: { ...MARK, workspace_id: String(w.id), plan_key: 'pro' } });
  assert.equal((await ws(alice)).plan_until, end1);
  const end2 = end1 + 30 * 86400;
  await hook('customer.subscription.updated', { object: 'subscription', id: 'sub_alice', customer: 'cus_alice', status: 'active', items: { data: [{ current_period_end: end2 }] }, metadata: {} });
  assert.equal((await ws(alice)).plan_until, end2, 'found via the customer/subscription id even without our metadata');

  await hook('invoice.payment_failed', { object: 'invoice', customer: 'cus_alice', subscription: 'sub_alice' });
  s = await ws(alice); assert.equal(s.plan_status, 'past_due'); assert.equal(s.plan.key, 'pro', 'a failed card does not drop the plan during the paid period');
  await hook('invoice.paid', { object: 'invoice', customer: 'cus_alice', subscription: 'sub_alice' });
  assert.equal((await ws(alice)).plan_status, 'active');

  await hook('customer.subscription.updated', { object: 'subscription', id: 'sub_alice', customer: 'cus_alice', status: 'active', cancel_at_period_end: true, current_period_end: end2 });
  assert.equal((await ws(alice)).plan.key, 'pro', 'cancelling keeps what was paid for');
  await hook('customer.subscription.deleted', { object: 'subscription', id: 'sub_alice', customer: 'cus_alice', status: 'canceled', ended_at: end2 });
  s = await ws(alice); assert.equal(s.plan_status, 'canceled'); assert.equal(s.plan.key, 'pro', 'until the paid period ends');
  // a subscription that ended long ago has lapsed back to Free
  await hook('customer.subscription.deleted', { object: 'subscription', id: 'sub_alice', customer: 'cus_alice', status: 'canceled', ended_at: nowSec() - 20 * 86400 });
  s = await ws(alice); assert.equal(s.lapsed, true); assert.equal(s.plan.key, 'free');
  assert.equal((await call('GET', '/api/public/pricing', null, alice)).body.current.plan_key, 'free');
});

test('one-time purchase: lifetime plan has no end date and ignores unpaid sessions', async () => {
  const w = (await call('POST', '/api/workspace/ensure', null, bob)).body;
  const sess = (extra = {}) => ({ object: 'checkout.session', mode: 'payment', customer: 'cus_bob', payment_status: 'paid', client_reference_id: String(w.id), metadata: { ...MARK, workspace_id: String(w.id), plan_key: 'lifetime' }, ...extra });
  await hook('checkout.session.completed', sess({ payment_status: 'unpaid' }));
  assert.equal((await ws(bob)).plan.key, 'free', 'not paid yet (bank transfer pending)');
  await hook('checkout.session.completed', sess());
  const s = await ws(bob);
  assert.equal(s.plan.key, 'lifetime'); assert.equal(s.plan_until, null); assert.equal(s.plan_source, 'stripe');
  assert.equal(s.plan.max_licenses, 10000);
  // already lifetime: a second purchase is refused, and the portal works for a known customer
  assert.equal((await call('POST', '/api/billing/checkout', { plan: 'lifetime' }, bob)).status, 409);
  stripeCalls.length = 0;
  const portal = await call('POST', '/api/billing/portal', null, bob);
  assert.equal(portal.body.url, 'https://billing.stripe.test/p/1');
  assert.equal(stripeCalls[0].form.customer, 'cus_bob'); assert.equal(stripeCalls[0].form.return_url, 'https://licenses.example.test/dashboard#billing');
});

test('events can only affect the workspace they belong to; strangers\' events are ignored', async () => {
  const w = await ws(bob), a = await ws(alice);
  const dup = { id: 'evt_dup_1' };
  const ev = { object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: String(a.id), metadata: { workspace_id: String(a.id), plan_key: 'lifetime' } };  // NO licensex marker
  const r = await hook('checkout.session.completed', ev);
  assert.equal(r.status, 200); assert.match(r.body.note, /ignored/);
  assert.equal((await ws(alice)).plan.key, 'free', 'an event for the owner\'s other Stripe products cannot grant plans');
  assert.match((await hook('checkout.session.completed', { ...ev, metadata: { ...MARK, workspace_id: '1', plan_key: 'lifetime' }, client_reference_id: '1' })).body.note, /ignored/, 'cannot touch the owner workspace');
  assert.match((await hook('checkout.session.completed', { ...ev, metadata: { ...MARK, workspace_id: '99999', plan_key: 'lifetime' } })).body.note, /ignored/);
  assert.match((await hook('checkout.session.completed', { ...ev, metadata: { ...MARK, workspace_id: String(a.id), plan_key: 'free' } })).body.note, /ignored: unknown plan/);
  assert.match((await hook('customer.subscription.updated', { object: 'subscription', id: 'sub_stranger', customer: 'cus_stranger', status: 'active' })).body.note, /ignored/);
  assert.equal((await ws(bob)).plan.key, 'lifetime', 'bob unaffected by any of that'); assert.equal(w.plan_key, 'lifetime');

  // duplicates (Stripe retries) are processed once
  const ok = { object: 'checkout.session', mode: 'payment', payment_status: 'paid', customer: 'cus_alice2', client_reference_id: String(a.id), metadata: { ...MARK, workspace_id: String(a.id), plan_key: 'lifetime' } };
  assert.match((await hook('checkout.session.completed', ok, dup)).body.note, /-> lifetime/);
  assert.equal((await hook('checkout.session.completed', ok, dup)).body.note, 'duplicate');
  assert.equal((await ws(alice)).plan.key, 'lifetime');
  assert.match((await hook('payment_intent.succeeded', { object: 'payment_intent' })).body.note, /not a handled event/);
});

test('manual grants win over Stripe subscription events', async () => {
  const c = await signIn(base, mock, googleUser('carol@devs.io'));
  const w = (await call('POST', '/api/workspace/ensure', null, c)).body;
  await call('POST', `/api/admin/customers/${w.id}/plan`, { plan_key: 'pro', until: null }, boss);
  assert.equal((await ws(c)).plan_source, 'manual');
  const r = await hook('customer.subscription.deleted', { object: 'subscription', id: 'sub_c', customer: 'cus_c', metadata: { ...MARK, workspace_id: String(w.id) }, ended_at: nowSec() - 86400 * 30 });
  assert.match(r.body.note, /managed manually/);
  assert.equal((await ws(c)).plan.key, 'pro');
  assert.equal((await call('POST', `/api/admin/customers/${w.id}/plan`, { plan_key: 'free' }, boss)).body.plan_source, 'free', 'owner can end it');
});

test('stripe settings: webhook address shown to the owner, secrets never sent to any browser', async () => {
  const s = (await call('GET', '/api/admin/settings', null, boss)).body;
  assert.equal(s.stripe.configured, true); assert.equal(s.stripe.webhook_configured, true);
  assert.equal(s.stripe.webhook_url, 'https://licenses.example.test/api/stripe/webhook');
  assert.ok(!JSON.stringify(s).includes('sk_test_abc123') && !JSON.stringify(s).includes(WHSEC), 'secrets are never sent to the browser');
});
