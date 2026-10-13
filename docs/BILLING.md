# Running LicenseX as a paid service

Other plugin developers can sign up, get a **private workspace**, and use LicenseX for their own plugins. You choose the
plans and prices, and you can take card payments with Stripe or hand plans out yourself.

## What customers get

- A workspace at **/dashboard**: their own products (plugins), licenses, groups, servers, settings and BuiltByBit secret.
  Nobody else can see or change anything in it. You (the owner) can open any workspace to help them.
- Limits from their plan: **how many plugins** and **how many licenses**. Everything else is the same on every plan.
- They sign in with Google, Discord or GitHub (see [LOGIN.md](LOGIN.md)). Signing in from the pricing page creates a free account.

## 1. Set the plans

Admin -> **Plans**. Three examples are created for you (Free, Pro monthly, Lifetime one-time). Change names, prices,
currencies, limits and the bullet points as you like, hide a plan (untick *For sale*), or add new ones (monthly, yearly or
one-time). The public page is **/pricing** and updates immediately. Prices are amounts in the plan's currency; Stripe's
minimum is about one unit of currency.

The **Free** plan always exists and is where everyone starts.

## 2. Take card payments with Stripe (optional)

Without Stripe the pricing page shows a *contact* button (your Discord or email from Settings) instead of *Buy*, and you
give plans by hand (see section 4). With Stripe, customers pay on Stripe's hosted checkout and their plan switches on
automatically.

1. Create a [Stripe](https://stripe.com) account. Start in **test mode**.
2. **API key:** Stripe Dashboard -> Developers -> API keys -> copy the **Secret key** (`sk_test_...`). Give it to LicenseX as
   `LICENSEX_STRIPE_SECRET_KEY`, or `stripe.secretKey` in `licensex.config.json`.
3. **Webhook:** Stripe Dashboard -> Developers -> Webhooks -> add an endpoint. The address is shown in the admin under
   **Plans -> Card payments** (it ends in `/api/stripe/webhook`; it must be your public `https://` address). Send these events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy the endpoint's **signing secret**
   (`whsec_...`) into `LICENSEX_STRIPE_WEBHOOK_SECRET` (or `stripe.webhookSecret`). Restart LicenseX.
4. **Customer portal** (lets customers update their card and cancel): Stripe Dashboard -> Settings -> Billing -> Customer
   portal -> turn it on and allow cancelling subscriptions and updating payment methods.
5. **Test it:** open `/pricing` signed in as a normal customer, press *Get Pro*, pay with Stripe's test card
   `4242 4242 4242 4242` (any future date, any CVC). Within seconds the dashboard shows the Pro plan.
6. **Go live:** switch Stripe to live mode, replace the key and the webhook secret with the live ones, and create the webhook
   again in live mode.

LicenseX never sees or stores card details. Stripe's checkout page does.

### What happens over time

| Event | Result |
|---|---|
| Customer buys a monthly/yearly plan | Plan switches on; billing period is tracked from Stripe |
| Renewal | Period end moves forward |
| Card fails | Marked *past due*; the plan stays on until the paid period ends (plus 3 days of slack) |
| Customer cancels | Keeps the plan until the end of the paid period |
| Period ends unpaid | Back to **Free limits** |
| Customer buys a one-time plan (Lifetime) | Plan has no end date |

**Existing licenses are never switched off** when a plan lapses. A customer's failed card must not take their buyers'
servers down. Dropping to Free only stops them *adding* more plugins/licenses than the Free plan allows.

Changing a plan's price later does not change what existing subscribers pay: each checkout is priced when it is created.

Refunds and chargebacks are not applied automatically. Handle them in Stripe, then in **Customers** press *Plan* and set
Free (or *Suspend*).

## 3. Open or closed signups

By default anyone who can sign in can create a free account. To make it **invite-only** set `LICENSEX_SIGNUPS=closed`
(or `"signups": "closed"` in the config). Then use **Customers -> Invite customer**: it creates their account and plan; they
sign in with that email and it is theirs.

## 4. Giving plans by hand

**Customers -> Plan**: pick any plan, with an end date or none. A hand-given plan is never changed by Stripe events, so it
suits gifts, friends and other payment methods (bank transfer, PayPal, BuiltByBit). Choosing *Free* ends it.

## 5. Looking after customers

- **Open:** see their workspace exactly as they do (a banner reminds you whose it is).
- **Suspend:** their licenses stop validating (their buyers' plugins refuse to start, with the reason you enter), downloads
  and BuiltByBit key delivery stop, and they cannot change anything. Use it for abuse. Unsuspend restores everything.
- **Delete:** removes the customer, their licenses, plugin files and servers permanently. It does not cancel a Stripe
  subscription; do that in Stripe.

## 6. Things to know before you open the doors

- **You hold your customers' data.** Their license keys, buyers' server IPs and plugin jars live on your server. Back it up
  (Settings -> Backup), keep it patched, and have a privacy policy and terms before you take other people's money.
- **Taxes, VAT, invoices and refunds are your responsibility.** LicenseX does not calculate tax.
- **"Build from source" is owner-only.** It runs build tools on your server, which is not safe to offer to strangers.
  Customers upload finished jars; wrapping a jar is plain file processing.
- **Storage is not metered.** Plans limit plugins and licenses, not megabytes; uploads are capped at 64 MB each
  (`LICENSEX_MAX_UPLOAD_MB`). Watch your disk.
- **Isolation is tested** (a dedicated test suite tries to read and change one customer's data from another's account), but
  a bug in any multi-tenant system can leak. Keep customers' data valuable-to-you only as long as necessary and review changes.
- Rate limits are in memory and per server process. Run one instance.
