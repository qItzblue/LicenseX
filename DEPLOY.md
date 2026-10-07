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
