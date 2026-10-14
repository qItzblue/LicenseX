# Sign in with Google, Discord or GitHub

There are two kinds of people on your site, and each has its own sign-in page. Both use the same providers and the
same setup (below); buttons only appear for the providers you configure.

| Page | Who it is for | Where sign-in lands |
|---|---|---|
| **`/login`** | The chooser: two cards, "I'm a creator" and "I'm a buyer". The header's **Sign in** link points here. | The card sends you to one of the pages below. |
| **`/login/creator`** | Plugin developers who sell with LicenseX. Signing in **creates their free workspace** the first time (see [BILLING.md](BILLING.md)). | `/dashboard` (or `/pricing` when they came from a "Buy" button). |
| **`/login/buyer`** | People who bought a plugin. No workspace is created. | `/account`, **My licenses**. |

Someone who is already signed in and opens `/login/creator` goes straight to the dashboard, and on `/login/buyer`
straight to My licenses. `/login` shows who is signed in, with buttons for everything they can open and **Sign out**.
Buyers who do not want an account can still use the key lookup on the home page; the buyer page links to it.
If a provider round trip fails (cancelled, expired, ...) the message appears on the page the visitor started from.

Only addresses on your admin list get the owner's **Admin** panel: people whose **verified email** is on it get an **Admin**
button in the site header, and the admin password keeps working as a backup way in.

## Buyer accounts (My licenses)

A buyer who signs in at `/login/buyer` (or any signed-in visitor opening `/account`) sees every license they own, the
servers using it, and can remove servers they no longer run. Licenses get onto the page in two ways:

- **They add the key.** The key box on the page links the license to their account (the same key that opens the home-page
  lookup). Up to 100 licenses per account; **Unlink** takes one off again without touching the license or its servers.
  Adding keys is rate limited, and a wrong key gets exactly the same answer as on the public lookup.
- **You issued it to their email.** A license whose buyer email matches one of the **provider-verified** emails of the
  person signed in shows up automatically (case does not matter). An address the provider has not verified never counts,
  and these licenses cannot be unlinked: they come from your side, not from the buyer.

Removing a server follows the same rules as the public page: it needs the developer's **self-service removal** setting
to be on, and a server an admin disabled cannot be removed. Nobody can see or touch a license they have not linked and
were not issued; the buyer pages never show notes, IP addresses or anything else from the admin side, and creators'
admin sessions and buyer accounts are completely separate.

An account is identified by the provider and the provider's own user id, not by an email. So signing in with Google and
with Discord gives two separate accounts (each with its own list), and a Discord account without a verified email works
too; it simply has no email-issued licenses.

You need to create a small "app" at each provider you want to offer (free, a few minutes each). Use only the ones
you like; buttons only appear for providers you set up.

## 0. What you need first

Your site's public address, e.g. `https://licenses.yourdomain.com` (or `https://licensex.onrender.com`). The providers
send people back to **`<your address>/auth/<provider>/callback`**, and the address must match exactly (https, no
trailing slash). The admin panel shows the exact three URLs under **Settings -> Sign-in & admin access**, with copy
buttons. Set `LICENSEX_PUBLIC_URL` (or `publicUrl` in the config) so the address is right.

## 1. Google

1. Open [Google Cloud Console](https://console.cloud.google.com), create (or pick) a project.
2. Go to **APIs & Services -> OAuth consent screen** (newer consoles call it **Google Auth Platform**). Choose
   **External**, fill in the app name and your email. Add the scopes `openid`, `email`, `profile` if asked.
   While the app is in **Testing**, only the test users you list can sign in. That is enough for admins; press
   **Publish app** if regular visitors should sign in too (these basic scopes need no Google review).
3. **Credentials -> Create credentials -> OAuth client ID -> Web application**.
   Under **Authorized redirect URIs** add `https://<your address>/auth/google/callback`.
4. Copy the **Client ID** and **Client secret**.

## 2. Discord

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) -> **New Application**.
2. **OAuth2** page: under **Redirects** add `https://<your address>/auth/discord/callback`.
3. Copy the **Client ID**, and press **Reset Secret** to get the **Client Secret**.

## 3. GitHub

1. GitHub -> **Settings -> Developer settings -> OAuth Apps -> New OAuth App**.
2. **Homepage URL**: your address. **Authorization callback URL**: `https://<your address>/auth/github/callback`.
   (GitHub allows only one callback per app.)
3. After creating it, copy the **Client ID** and press **Generate a new client secret**.

## 4. Give LicenseX the keys

Either in `licensex.config.json`:
```json
{
  "adminEmails": ["you@example.com"],
  "oauth": {
    "google":  { "clientId": "...", "clientSecret": "..." },
    "discord": { "clientId": "...", "clientSecret": "..." },
    "github":  { "clientId": "...", "clientSecret": "..." }
  }
}
```
or as environment variables (these win over the file; handy on Render):

| Variable | Meaning |
|---|---|
| `LICENSEX_ADMIN_EMAILS` | Comma-separated emails that are always admins |
| `LICENSEX_GOOGLE_CLIENT_ID` / `LICENSEX_GOOGLE_CLIENT_SECRET` | Google app |
| `LICENSEX_DISCORD_CLIENT_ID` / `LICENSEX_DISCORD_CLIENT_SECRET` | Discord app |
| `LICENSEX_GITHUB_CLIENT_ID` / `LICENSEX_GITHUB_CLIENT_SECRET` | GitHub app |
| `LICENSEX_DISABLE_PASSWORD_LOGIN=1` | Turn the admin password off (needs a provider and an admin email configured, otherwise LicenseX refuses to start so nobody gets locked out) |

Restart LicenseX. The buttons appear on the creator and buyer sign-in pages.

## 5. Choose who is an admin

- **The first admin:** put your email in `adminEmails` / `LICENSEX_ADMIN_EMAILS`. Those addresses are always admins and
  cannot be removed from the web UI, so you can never lock yourself out of the settings.
- **More admins:** admin panel -> **Settings -> Sign-in & admin access -> Admin emails** (one per line) -> **Save admins**.
  It takes effect immediately, and removing an address cuts that person's access on their very next click.

Then sign in with a provider whose email is on the list, and the **Admin** button appears at the top right.

## How it decides who is an admin

- Only emails the provider says are **verified** count (Google `email_verified`, Discord `verified`, GitHub's verified
  addresses). Someone who types your address into a provider without verifying it does not become an admin.
- GitHub people can have several verified addresses; any one of them on the list is enough. Discord and Google have one.
- Matching ignores upper/lower case. The same person signing in through Google or GitHub both work, as long as the
  verified email is on the list.
- If a provider shares no verified email (for example a Discord account with an unverified email), that person can still
  sign in as a normal user, but can never be an admin. The login page says why.
- Sign-in sessions last 7 days. Admin rights are checked on every request, not stored in the session.
- Ordinary visitors are not admins and cannot see or call anything in the admin panel; they get an account chip,
  **My licenses** and **Sign out** in the header (plus **Dashboard** when they own a workspace).

## Troubleshooting

| Message | Cause |
|---|---|
| Provider says "redirect_uri mismatch" | The callback URL registered at the provider differs from the one LicenseX uses. Copy it from Settings, and set `LICENSEX_PUBLIC_URL`. |
| "That sign-in link expired or was already used" | The sign-in took more than 10 minutes, cookies are blocked, or the page was opened from a different address than the one configured. |
| "The provider did not complete the sign-in" | Wrong client secret, or the provider could not be reached. Check the server log and the **Audit log** (`login.error`). |
| Signed in but no Admin button | The account's verified email is not on the list. The login page shows which email it saw. |
| A buyer says their licenses are gone after signing in | They used another provider than last time (Google and Discord are separate accounts). Sign in with the original one, or add the keys again. |
| A license issued to an email does not show up for the buyer | Their provider did not verify that address (for example an unverified Discord email), or it is a different address than the one on the license. |
| Google: "Access blocked" | The consent screen is in Testing and your email is not a listed test user, or press **Publish app**. |
