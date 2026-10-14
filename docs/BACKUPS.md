# Off-site backups (and surviving Render's free tier)

Render's free plan (and some other hosts) wipe the disk on every restart, redeploy or spin-down. With off-site backups
LicenseX keeps a copy of everything somewhere else and, when it starts on an empty disk, **puts the latest copy back by
itself**. Licenses, products and their jar files, customers, team, settings and two-factor setups are all included.

When a copy is sent:
- every hour (`LICENSEX_BACKUP_EVERY_MINUTES`), **only if something changed**;
- right before the server stops (Render sends a stop signal on deploys, restarts and spin-downs): a last copy;
- when you press **Settings -> Off-site backups -> Back up now**.

Status (last copy, errors) is on that same card. Everything is set with **environment variables**, not in the dashboard,
because the dashboard's database is exactly what gets wiped.

## Option 1: S3-style storage (recommended, restores itself)

Works with Backblaze B2 (10 GB free), Cloudflare R2 (10 GB free), Amazon S3, MinIO and other S3-compatible storage.

**Backblaze B2, step by step**
1. Make an account at backblaze.com -> **B2 Cloud Storage** -> **Buckets -> Create a Bucket**. Name e.g.
   `myname-licensex`, files **Private**.
2. Note the bucket's **Endpoint**, e.g. `s3.eu-central-003.backblazeb2.com`.
3. **Application Keys -> Add a New Application Key**: allow access to that bucket only, **Read and Write**. Copy the
   **keyID** and **applicationKey** (shown once).
4. In Render: your service -> **Environment** -> add:

| Variable | Value |
|---|---|
| `LICENSEX_BACKUP_S3_ENDPOINT` | `https://s3.eu-central-003.backblazeb2.com` (yours, with `https://`) |
| `LICENSEX_BACKUP_S3_BUCKET` | `myname-licensex` |
| `LICENSEX_BACKUP_S3_ACCESS_KEY` | the keyID |
| `LICENSEX_BACKUP_S3_SECRET_KEY` | the applicationKey |
| `LICENSEX_BACKUP_PASSWORD` | a long random password (encrypts every copy; **keep it somewhere safe**: without it no copy can be opened) |

5. Save. Render redeploys; open **Settings -> Off-site backups** and press **Back up now**. It should say "Last copy just now".

**Cloudflare R2:** endpoint `https://<account id>.r2.cloudflarestorage.com`, create an R2 API token with Object Read & Write.
**Amazon S3:** endpoint `https://s3.<region>.amazonaws.com`.
Optional: `LICENSEX_BACKUP_S3_REGION` (worked out from the endpoint when possible, else `auto`) and
`LICENSEX_BACKUP_S3_PREFIX` (folder, default `licensex/`).

In the bucket you get `licensex/latest.zip.enc` (always the newest) and `licensex/daily/<date>.zip.enc` (one per day).
Add a lifecycle rule in your bucket if you want old daily copies deleted after, say, 30 days.

## Option 2: a Discord channel

1. In a **private** Discord channel: **Edit Channel -> Integrations -> Webhooks -> New Webhook -> Copy Webhook URL**.
2. Set `LICENSEX_BACKUP_DISCORD_WEBHOOK` to that URL (and `LICENSEX_BACKUP_PASSWORD`, strongly recommended: anyone in the
   channel can download the file).

Discord gets a copy at most every 6 hours (`LICENSEX_BACKUP_DISCORD_EVERY_MINUTES`, default 360) plus one when the server
stops. Discord copies are **not restored automatically**: after a wipe, download the newest file from the channel and use
**Settings -> Backup & move -> Restore from backup**. Webhooks take files up to 10 MB; if your plugin jars make the backup
bigger, Discord gets a copy without the jar files (upload them again after restoring), so use S3-style storage for big plugins.

You can use both at the same time.

## Restoring

- **Automatic (S3):** when LicenseX starts and its database is missing or empty, it downloads `latest` and restores it
  before it accepts any request. Turn this off with `LICENSEX_BACKUP_RESTORE_ON_START=0`.
- If that restore fails (wrong `LICENSEX_BACKUP_PASSWORD`, damaged file), LicenseX starts empty and **stops sending
  copies**, so the good copy in storage is never overwritten by an empty one. The Settings card says so; fix the problem
  and restart, or press **Back up now** if you really want to replace the stored copy.
- **By hand:** **Settings -> Backup & move -> Restore from backup** accepts normal and encrypted (`.enc`) backups (it uses
  `LICENSEX_BACKUP_PASSWORD` to open them).

## Good to know

- Copies contain every license key (and the two-factor secrets). Set `LICENSEX_BACKUP_PASSWORD`.
- Changes made after the last copy and before a crash (not a normal stop) are lost. With the hourly check that is at most
  an hour; lower `LICENSEX_BACKUP_EVERY_MINUTES` (minimum 5) if you want.
- Sign-in sessions do not survive a wipe: everyone signs in again once.
- The same settings can go in `licensex.config.json` under `"backup"` (see `licensex.config.example.json`), but on Render use
  environment variables.
