# Selling LicenseX plans on BuiltByBit

Other plugin developers can use your LicenseX as a service: each one gets a private workspace. You sell the plans on
**BuiltByBit**, which is where your buyers already are, with exactly two paid plans:

| Plan | How it is sold | What the buyer gets |
|---|---|---|
| **Pro** | one **monthly** resource on BuiltByBit | a new access key every month; each key switches the plan on for 31 days |
| **Lifetime** | one **one-time** resource on BuiltByBit | one access key; the plan never ends |

There is also a **Free** plan. Names, prices, limits and feature lists are edited under **Admin -> Plans**; the prices are
what the pricing page shows, the money itself moves on BuiltByBit.

## How it works for the buyer

1. On **/pricing** they press **Buy on BuiltByBit** and pay there.
2. They download the file from the resource. BuiltByBit writes their personal **access key** (`LX-XXXX-...`) into it.
3. In their dashboard, **Billing -> Activate a key**: paste the key, and the plan is on.

A key works **once, for one workspace**. Somebody with no account yet can activate straight from the sign-in: a valid key
creates their workspace together with the plan, even when signups are closed.

When a plan ends (monthly not renewed), existing licenses **keep working**; the workspace just cannot add more than the
Free plan allows. Renewing is the same thing again: the next month's file has a new key, and activating it adds 31 days on
top of what is left.

## Setting it up (once)

1. **Put LicenseX online** and sign in as the owner ([DEPLOY.md](../DEPLOY.md)). Open **Plans** and note the **URL** and the
   **Secret for plan resources** in the "Selling plans on BuiltByBit" card. This secret is separate from the one under Settings
   (which your team can see): only you can read or change it, and only it hands out plan keys.
2. **Create two resources on BuiltByBit**: a monthly one and a one-time one. Each contains one small text file, for example
   `ACCESS-KEY.txt`, with a single line: `%%__BBB_LICENSE__%%`.
3. On each resource add the **External license key** placeholder (`%%__BBB_LICENSE__%%`) pointing at the **URL** from step 1,
   with that **Secret**. (It is the same kind of placeholder as for selling a plugin, see [BUILTBYBIT.md](BUILTBYBIT.md), just with
   the plan-sales secret.)
4. In **Admin -> Plans**, edit **Pro** and **Lifetime**: paste the resource's **BuiltByBit buy link** and **resource id**
   (the number in the resource's address). The id is how LicenseX knows which plan a key is for.
5. **Test it** with a real purchase (or a free test copy) before you announce anything: download, copy the key, activate it
   from a second account.

Without a buy link, the pricing page shows your Discord or support email instead.

## Looking after it

- **Plans -> Access keys handed out** lists every key with its buyer, the plan and whether it was used (and by whom).
  Access keys are not licenses: they never show up under Licenses, a plugin or the public license page does not accept them,
  and your team members cannot see them.
- **Refund:** press **Cancel** on the key before it is used and it can never be activated. If it was already used, change
  the customer's plan under **Customers -> Plan** (Free ends it).
- **New secret:** if the secret leaks, press **New secret** on the Plans page and put the new one into your plan resources.
- **Gifts / other payment methods:** give a plan by hand under **Customers -> Plan**; it needs no key.
- A used key stays on record when its customer is deleted, so it cannot be used again. Backups include the list.
- A plan with no end date (Lifetime, or one you granted by hand) is never replaced or shortened by a key; such a key is refused
  and stays unused.

## What I could not verify

I could not open BuiltByBit's own pages while writing this, so two things come from its public placeholder descriptions and
third-party guides rather than from testing against BuiltByBit: the exact fields BuiltByBit sends to the placeholder URL, and
how a **monthly** resource behaves. LicenseX gives a fresh key for every calendar month in which someone downloads, so the
monthly plan is only as paid as BuiltByBit's download access is: **if BuiltByBit lets people download after they stop paying,
they get a new key every month for free.** In your test purchase, cancel the subscription and check that the file can no longer
be downloaded. If it still can, sell the monthly plan as a series of one-month purchases, or give it by hand under Customers.

## Customers you invite

**Admin -> Customers -> Invite** creates an account for an email address with a plan you choose; whoever signs in with that
(verified) email owns it. Set `LICENSEX_SIGNUPS=closed` to make that the only way in (plus a valid BuiltByBit key).
