# Selling plans through Patreon

People pay you monthly on Patreon. Their LicenseX account gets the **Pro** plan and stays Pro for as long as they keep
paying, with no keys to copy. The money goes from Patreon to you, and LicenseX only listens.

```
patron pays on Patreon
   -> Patreon tells LicenseX (webhook)
   -> LicenseX gives the patron's account Pro until their next payment date (+3 days of slack)
every following month: the same, by itself
patron cancels or a payment fails
   -> nothing is switched off early; Pro just runs out at the end of the month they paid for
```

**How a patron is matched to their LicenseX account**

- **Connect Patreon** (Billing page): they sign in to Patreon once, which proves who they are. Their Patreon email can be
  completely different from the one they use for LicenseX.
- **Automatic**: if their Patreon email is the email they sign in to LicenseX with, no connecting is needed.

## 1. Make a Patreon tier

On patreon.com, open your creator page -> **Tiers** -> create a tier, e.g. "LicenseX Pro", at your monthly price.
Describe what they get and that they should sign in at `https://YOUR-SITE/login` and press **Connect Patreon** on Billing.

## 2. Register a Patreon client (for the Connect Patreon button)

1. Sign in to Patreon as the creator and open <https://www.patreon.com/portal/registration/register-clients>.
2. **Create Client**:
   - **App Name:** your site name, e.g. LicenseX
   - **Description:** "Connects your Patreon to your LicenseX account"
   - **Redirect URIs:** `https://YOUR-SITE/auth/patreon/callback` (exactly your `publicUrl` plus `/auth/patreon/callback`)
   - **Client API Version:** 2
3. Save, then open the client and copy the **Client ID** and **Client Secret**.

## 3. Register a webhook (Patreon tells LicenseX about payments)

1. Open <https://www.patreon.com/portal/registration/register-webhooks>.
2. Add a webhook with the URL `https://YOUR-SITE/api/patreon/webhook`.
3. Tick these triggers: `members:create`, `members:update`, `members:delete`,
   `members:pledge:create`, `members:pledge:update`, `members:pledge:delete`.
4. Copy the webhook's **secret**.

## 4. Put the three values into LicenseX

In `licensex.config.json` (mind the commas):

```json
  "patreon": {
    "clientId": "PASTE CLIENT ID",
    "clientSecret": "PASTE CLIENT SECRET",
    "webhookSecret": "PASTE WEBHOOK SECRET",
    "plan": "pro"
  },
```

or as environment variables: `LICENSEX_PATREON_CLIENT_ID`, `LICENSEX_PATREON_CLIENT_SECRET`,
`LICENSEX_PATREON_WEBHOOK_SECRET`, and optionally `LICENSEX_PATREON_PLAN` (which plan patrons get, default `pro`).

Restart LicenseX (`sudo systemctl restart licensex`). The Billing page of every customer now shows **Pay with Patreon**.

## 4b. Several tiers, several plans (optional)

Without this, every paid tier gives the `plan` above. To give each tier its own plan, list them by tier id:

```json
  "patreon": {
    "clientId": "...", "clientSecret": "...", "webhookSecret": "...",
    "tiers": { "12345678": "pro", "23456789": "lifetime" }
  }
```

(or `LICENSEX_PATREON_TIERS=12345678:pro,23456789:lifetime`). The plan names on the right are the plan **keys** shown in
**Admin -> Plans** (renaming a plan keeps its key). With a list, a tier that is not in it gives no plan; a patron in
several listed tiers gets the most expensive plan.

**Finding a tier id:** have someone join the tier (or press **Send test** on the webhook page), then look in LicenseX
**Audit log** for `patreon.event`: it ends in `tiers=<id>`.

## 5. Test it

1. On the Patreon webhook page, press **Send test** for `members:pledge:create`. In LicenseX **Audit log** you should see
   `patreon.event`. (A test patron usually has no paid charge, so no plan changes; that is expected.)
2. With a second account: sign in to LicenseX, become a patron of your tier, then **Billing -> Connect Patreon**.
   It should say "Patreon connected. Your plan is on." and Billing shows Pro with an end date about a month away.
3. A month later (or after Patreon's next charge) the end date moves forward by itself.

## Good to know

- Pro is given only for a **paid** charge (`active_patron` + `Paid`). Declined payments and former patrons keep the
  time they already paid for, then drop to Free. Their existing licenses keep working; they just cannot add more than Free allows.
- Someone with a plan that has no end date (Lifetime, or one you granted by hand without one) is never changed by Patreon.
- One Patreon account belongs to one LicenseX account. **Disconnect** on the Billing page frees it.
- Without a `tiers` list, any paid tier counts (see 4b).
- I could not test against the real Patreon (only a stand-in that answers like its documented API), so do step 5 before
  you announce it.
