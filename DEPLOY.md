# Putting LicenseX online

LicenseX is a small Node.js program with no dependencies. To run it you need **a host that runs Node.js 22.13 or
newer** and **keeps the `data/` folder** (that is where every license lives). A host that only serves static
files or PHP (InfinityFree, GitHub Pages, ...) cannot run it.

## The quick version

1. Unzip this folder on the host (it already contains everything, there is nothing to install or build).
2. Copy `licensex.config.example.json` to `licensex.config.json` and set `adminPassword` and `publicUrl`
   (or set the same things as environment variables, see below).
3. Start it: `node server/index.js` (or `./start.sh`, or double-click `start.bat` on Windows).
4. Open `https://your-address/admin` and sign in.

`licensex.config.json` keys: `adminPassword`, `publicUrl` (the public https address), `port`, `trustProxy`
(true when a proxy or the host sits in front, which is the normal case online), `dataDir`, `maxUploadMb`.
Environment variables override the file: `LICENSEX_ADMIN_PASSWORD`, `LICENSEX_PUBLIC_URL`, `PORT`, `TRUST_PROXY=1`,
`LICENSEX_DATA`, `LICENSEX_MAX_UPLOAD_MB`.

## Where to host it

Free plans change often. This was last checked in October 2026, so confirm on the provider's page.

| Host | Free? | Good for LicenseX? |
|---|---|---|
| [alwaysdata](https://www.alwaysdata.com) | Permanent free plan (about 100 MB), Node.js sites, SSH/FTP upload | **Best free option I found.** Keeps its disk. Choose a Node version of 22.13 or newer in the site settings. |
| Your own PC / Raspberry Pi + [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) | Free | Works if the machine stays on 24/7. Plugins keep running for 72 hours without contact, but nobody can download or check licenses while it is off. |
| A small VPS | A few dollars a month | The solid choice once you are selling. |
| [Render](https://render.com/docs/free) free web service | Free, no card | **Testing only.** It sleeps after 15 minutes without traffic (about a minute to wake) and its disk is wiped on every restart, so licenses disappear. Use **Settings -> Backup & move** to save and restore. |
| Railway | One-time trial credit, not a free plan | Fine for trying it out for a few weeks. Add a volume mounted at the data folder. |
| Koyeb, Fly.io | Need a credit card | Can work with a persistent volume. |

Why not "always free and asleep" hosts for selling: BuiltByBit asks LicenseX for a key at the moment a buyer
downloads. If your host is asleep or slow to wake, that buyer gets "Unable to acquire a license key automatically".

## Sign-in with Google / Discord / GitHub

Optional, but it lets you open the admin panel from a button on your site instead of typing the password. See
**[docs/LOGIN.md](docs/LOGIN.md)** (needs `LICENSEX_PUBLIC_URL` to be your real https address).

## Render, step by step

Render deploys from GitHub, not from the zip.

1. Put the project in a GitHub repo you control (this one is `qItzblue/LicenseX`, branch `claude/dreamy-cori-gp73ku`;
   merge it to `main` or choose that branch on Render). Private repos work once you connect GitHub to Render.
2. On [render.com](https://render.com): **New + -> Blueprint**, pick the repo and branch. Render reads `render.yaml`.
   (No Blueprint? **New + -> Web Service**, pick the repo, **Language: Docker**, Instance type **Free**.)
3. Enter the two values it asks for: `LICENSEX_ADMIN_PASSWORD` (long and random) and `LICENSEX_PUBLIC_URL`. You only
   learn the address after the first deploy (`https://something.onrender.com`), so put a guess, then fix it under
   **Environment** and let it redeploy.
4. Wait for **Live**, then open `https://<your-service>.onrender.com/admin` and sign in.
5. In **Settings**, the BuiltByBit URL now shows your Render address.

**Read this before relying on it.** On the **free** plan:
- The disk is wiped whenever the service restarts, redeploys or spins down, so **every license is lost** each time.
  Download a backup (**Settings -> Backup & move**) before anything you do on Render and restore it afterwards.
- The service sleeps after 15 minutes without traffic and takes about a minute to wake. Running servers keep working for
  72 hours without contact, but a buyer who downloads during the sleep may get no key from BuiltByBit.

That is fine for trying everything out. To sell, use a **paid** instance with a **persistent disk** mounted at `/data`
(uncomment the `disk:` block in `render.yaml`, or add the disk under the service's settings). `/data` is already where
the Docker image keeps your data. Plans and prices change, so check Render's pricing page.

## Docker

```
docker build -t licensex .
docker run -d -p 3000:3000 -v licensex-data:/data -e LICENSEX_ADMIN_PASSWORD='a-long-password' -e LICENSEX_PUBLIC_URL=https://licenses.example.com licensex
```
The `-v licensex-data:/data` part is what keeps your licenses when the container is replaced.

## HTTPS

BuiltByBit and buyers' servers need an `https://` address. Most hosts above provide it. On your own server put
[Caddy](https://caddyserver.com/docs/install) in front:
```
licenses.example.com {
  reverse_proxy localhost:3000
}
```

## Moving to a new host later

1. Old host: admin -> **Settings -> Backup & move -> Download backup**.
2. New host: start LicenseX, sign in, **Restore from backup**.
3. Point your domain (or the BuiltByBit placeholder URL, and `licensex-url` in future plugin builds) at the new host.

The backup holds every license key and your BuiltByBit secret, so keep it private.
