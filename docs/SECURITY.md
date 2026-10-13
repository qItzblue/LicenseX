# Two-factor sign-in and the leak tracer

## Two-factor sign-in (authenticator app)

Every account turns it on for itself in the dashboard: **Security -> Set up two-factor sign-in**. Scan the QR code with
Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden or similar, enter the 6-digit code, and save
the 8 recovery codes it shows (each works once, for when your phone is gone).

- The **admin password** is one account, every Google/Discord/GitHub email another. Turn it on for each one you use.
- After that, signing in asks for the code: the admin form shows a code field, and Google/Discord/GitHub sign-ins go to
  `/login/2fa` first. Recovery codes work in the same box.
- Turning it on signs out every other session of that account at once (handy if you think someone got in).
- Codes work once, and guessing is limited to 10 tries per 10 minutes per account and per address.
- **Locked out?** The site owner can switch it off for an email address under **Security -> Locked out?**. For the admin
  password itself (or the owner's own email), start the server once with `LICENSEX_RESET_2FA=password` (or
  `LICENSEX_RESET_2FA=you@example.com`), then remove the variable again.
- Changing the code app: switch it off (needs a code) and set it up again.

What it does not protect against: someone who already has a signed-in browser session (cookies are valid for up to 7 days
for Google/Discord/GitHub sign-ins and 12 hours for the admin password). Signing out on shared computers still matters.

## Leak tracer

Every jar downloaded through a product's download link is unique: it has its buyer's own license key **and** a random
mark, stored in two places inside the file. LicenseX remembers which download got which mark (time, IP address, browser,
BuiltByBit user id).

Found your plugin on a leak site? Open **Leak tracer** in the dashboard and drop the jar on it (the file is read and thrown
away, not stored). You see one of:

| Result | Meaning |
|---|---|
| Found the leaker | The mark and the key both point to the same download. |
| Key was swapped | The mark says who downloaded it, but someone put another license key in. Both are shown. |
| Found the download | The key was removed, the mark was not. |
| Found the license | Only the key is left (older downloads made before marks existed, BuiltByBit placeholder builds, or a cleaned-up file). |
| Nothing found | No key or mark from your workspace. |

Then press **Block this license**: every server using it stops at its next check-in. Team members need *See licenses* to
use the tracer (and *Block and unblock licenses* to block), and only find licenses of their own products.

Limits, honestly: someone who knows how LicenseX works can remove both marks and the key; then nothing is left to find.
Most leakers just re-upload the file they downloaded, which is exactly what this catches.
