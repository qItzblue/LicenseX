// Stripe billing without the Stripe SDK: Checkout sessions, the customer portal, webhook signature checks and the
// handlers that turn Stripe events into a workspace's plan. Everything here is idempotent: Stripe retries and
// delivers events more than once and out of order.
import { createHmac, timingSafeEqual } from 'node:crypto';

export class StripeError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

/** {a:{b:1}, c:[{d:2}]} -> a[b]=1&c[0][d]=2 (Stripe's form encoding) */
export function formEncode(obj) {
  const params = new URLSearchParams();
  const walk = (v, key) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, key ? `${key}[${k}]` : k);
    else params.append(key, String(v));
  };
  walk(obj, '');
  return params;
}

/** https://docs.stripe.com/webhooks : HMAC-SHA256 over `${timestamp}.${rawBody}` keyed with the endpoint secret. */
export function verifySignature(rawBody, header, secret, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret || !header) return false;
  const parts = String(header).split(',').map(p => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v).filter(Boolean); // ignore other schemes (downgrade protection)
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;                  // replay protection
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return sigs.some(sig => {
    const got = Buffer.from(sig, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

const DAY = 86400;

export function createBilling({ db, core, cfg, log = () => {} }) {
  const enabled = () => !!cfg.secretKey;

  async function stripe(path, params) {
    if (!cfg.secretKey) throw new StripeError('Online payments are not set up.', 503);
    let res;
    try {
      res = await fetch(cfg.apiBase + path, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { Authorization: 'Basic ' + Buffer.from(cfg.secretKey + ':').toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formEncode(params),
      });
    } catch (e) { throw new StripeError('Could not reach Stripe. Try again in a moment.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { log('stripe.error', path, data?.error?.message || res.status); throw new StripeError(data?.error?.message ? `Stripe: ${data.error.message}` : 'Stripe refused the request.'); }
    return data;
  }

  /** Creates a hosted Checkout page for `plan` (a plans row) and returns its URL. */
  async function checkout({ ws, plan, email, siteName, base }) {
    if (!(plan.price_cents > 0) || !['month', 'year', 'once'].includes(plan.interval)) throw new StripeError('That plan is not for sale.', 400);
    const sub = plan.interval !== 'once';
    const meta = { licensex: '1', workspace_id: String(ws.id), plan_key: plan.key };
    const data = await stripe('/v1/checkout/sessions', {
      mode: sub ? 'subscription' : 'payment',
      success_url: `${base}/dashboard?paid=1#billing`,
      cancel_url: `${base}/pricing`,
      client_reference_id: String(ws.id),
      ...(ws.stripe_customer_id ? { customer: ws.stripe_customer_id } : { customer_email: email }),
      line_items: [{ quantity: 1, price_data: {
        currency: plan.currency, unit_amount: plan.price_cents,
        product_data: { name: `${siteName} ${plan.name}` },
        ...(sub ? { recurring: { interval: plan.interval } } : {}) } }],
      metadata: meta,
      ...(sub ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }),
    });
    if (!data.url) throw new StripeError('Stripe did not return a checkout address.');
    return data.url;
  }

  async function portal({ ws, base }) {
    if (!ws.stripe_customer_id) throw new StripeError('There is nothing to manage yet. Choose a paid plan first.', 400);
    const data = await stripe('/v1/billing_portal/sessions', { customer: ws.stripe_customer_id, return_url: `${base}/dashboard#billing` });
    if (!data.url) throw new StripeError('Stripe did not return a billing portal address.');
    return data.url;
  }

  // ---- events ---------------------------------------------------------------------------------
  const wsById = id => db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  const paidPlan = key => { const p = key && db.prepare('SELECT * FROM plans WHERE key = ?').get(key); return p && p.price_cents > 0 ? p : null; };

  /** Which workspace does this Stripe object belong to? Only objects we created (marker) or ids we stored. */
  function workspaceFor(obj) {
    const meta = obj.metadata || {};
    const claimed = Number(meta.workspace_id || obj.client_reference_id);
    if (meta.licensex === '1' && Number.isInteger(claimed) && claimed > core.HOUSE) { const w = wsById(claimed); if (w) return w; }
    const sub = obj.object === 'subscription' ? obj.id : (typeof obj.subscription === 'string' ? obj.subscription : null);
    if (sub) { const w = db.prepare('SELECT * FROM workspaces WHERE stripe_subscription_id = ?').get(sub); if (w) return w; }
    if (typeof obj.customer === 'string') return db.prepare('SELECT * FROM workspaces WHERE stripe_customer_id = ?').get(obj.customer) || null;
    return null;
  }

  const periodEnd = sub => sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
  const set = (w, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE workspaces SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => fields[k]), w.id);
  };

  const handlers = {
    'checkout.session.completed'(s) {
      const w = workspaceFor(s); if (!w) return 'ignored: unknown workspace';
      const plan = paidPlan(s.metadata?.plan_key); if (!plan) return 'ignored: unknown plan';
      if (s.mode === 'payment') {
        if (s.payment_status !== 'paid') return 'ignored: not paid yet';
        set(w, { plan_key: plan.key, plan_status: 'active', plan_until: null, plan_source: 'stripe', stripe_customer_id: s.customer || w.stripe_customer_id, stripe_subscription_id: null });
      } else if (s.mode === 'subscription') {
        // exact period comes with customer.subscription.updated; until then, one period plus slack
        const t = core.now() + (plan.interval === 'year' ? 367 : 32) * DAY;
        set(w, { plan_key: plan.key, plan_status: 'active', plan_until: t, plan_source: 'stripe', stripe_customer_id: s.customer || w.stripe_customer_id, stripe_subscription_id: s.subscription || null });
      } else return 'ignored: mode';
      core.log('stripe', 'billing.purchase', plan.key, `${s.mode} ${plan.price_cents}${plan.currency}`, w.id);
      return `workspace ${w.id} -> ${plan.key}`;
    },
    'customer.subscription.created': sub => handlers['customer.subscription.updated'](sub),
    'customer.subscription.updated'(sub) {
      const w = workspaceFor(sub); if (!w) return 'ignored: unknown workspace';
      if (w.plan_source === 'manual') return 'ignored: plan is managed manually';
      if (w.stripe_subscription_id && w.stripe_subscription_id !== sub.id) return 'ignored: not the current subscription';
      const status = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled' }[sub.status];
      if (!status) return `ignored: status ${sub.status}`;
      const until = periodEnd(sub);
      const plan = paidPlan(sub.metadata?.plan_key) || paidPlan(w.plan_key);
      set(w, { plan_status: status, ...(until ? { plan_until: until } : {}), ...(plan ? { plan_key: plan.key } : {}), plan_source: 'stripe', stripe_subscription_id: sub.id, stripe_customer_id: sub.customer || w.stripe_customer_id });
      core.log('stripe', 'billing.subscription', status, `until=${until || '-'} cancel_at_period_end=${!!sub.cancel_at_period_end}`, w.id);
      return `workspace ${w.id} subscription ${status}`;
    },
    'customer.subscription.deleted'(sub) {
      const w = workspaceFor(sub); if (!w) return 'ignored: unknown workspace';
      if (w.plan_source === 'manual') return 'ignored: plan is managed manually';
      if (w.stripe_subscription_id && w.stripe_subscription_id !== sub.id) return 'ignored: not the current subscription';
      set(w, { plan_status: 'canceled', plan_until: sub.ended_at || periodEnd(sub) || core.now() });
      core.log('stripe', 'billing.canceled', '', '', w.id);
      return `workspace ${w.id} canceled`;
    },
    'invoice.payment_failed'(inv) {
      const w = workspaceFor(inv); if (!w || w.plan_source === 'manual' || !w.stripe_subscription_id) return 'ignored';
      set(w, { plan_status: 'past_due' });
      core.log('stripe', 'billing.payment_failed', '', '', w.id);
      return `workspace ${w.id} past_due`;
    },
    'invoice.paid'(inv) {
      const w = workspaceFor(inv); if (!w || w.plan_source === 'manual' || !w.stripe_subscription_id) return 'ignored';
      if (w.plan_status === 'past_due') set(w, { plan_status: 'active' });
      return `workspace ${w.id} paid`;
    },
  };

  /** Processes one verified event. Returns a short note about what happened. */
  function handleEvent(event) {
    if (!event?.id || !event.type) throw new StripeError('Malformed event', 400);
    if (db.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(event.id)) return 'duplicate';
    const fn = handlers[event.type];
    const note = fn ? fn(event.data?.object || {}) : 'ignored: not a handled event';
    db.prepare('INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?, ?)').run(event.id, core.now());
    return note;
  }

  return { enabled, checkout, portal, handleEvent, stripe };
}
