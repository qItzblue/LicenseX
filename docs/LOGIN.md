# Sign in with Google, Discord or GitHub

Visitors can sign in from the site header. People whose **verified email** is on your admin list get an **Admin**
button there, which opens the admin panel. The admin password keeps working as a backup way in.

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

Restart LicenseX. The three buttons appear on `/login`.

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
- Ordinary visitors are not admins and cannot see or call anything in the admin panel; they only get an account chip
  and **Sign out** in the header.

## Troubleshooting

| Message | Cause |
|---|---|
| Provider says "redirect_uri mismatch" | The callback URL registered at the provider differs from the one LicenseX uses. Copy it from Settings, and set `LICENSEX_PUBLIC_URL`. |
| "That sign-in link expired or was already used" | The sign-in took more than 10 minutes, cookies are blocked, or the page was opened from a different address than the one configured. |
| "The provider did not complete the sign-in" | Wrong client secret, or the provider could not be reached. Check the server log and the **Audit log** (`login.error`). |
| Signed in but no Admin button | The account's verified email is not on the list. The login page shows which email it saw. |
| Google: "Access blocked" | The consent screen is in Testing and your email is not a listed test user, or press **Publish app**. |
