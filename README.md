# LicenseX

License server, owner portal and admin panel for Minecraft plugins sold on BuiltByBit (or anywhere else).
Zero npm dependencies: Node 22.13+ (uses built-in `node:sqlite`).

```
npm start                        # http://localhost:3000, admin at /admin
LICENSEX_ADMIN_PASSWORD=... npm start
npm test
```

If `LICENSEX_ADMIN_PASSWORD` is unset a random one is generated into `data/admin-password.txt`.
Other env: `PORT`, `LICENSEX_DATA` (data dir), `TRUST_PROXY=1` (read client IP from `X-Forwarded-For` behind a reverse proxy; required for correct IPs in production, and put TLS in front).

## How it works

| Piece | What it does |
|---|---|
| `server/` | HTTP API + SQLite. Business rules live in `core.js`. |
| `web/index.html` | Public page: enter a license key, see servers on it, remove any of them. |
| `web/admin.html` | Admin: licenses, servers, **products/downloads**, groups, global settings, audit log. |
| `server/jarstamp.js` | Dependency-free ZIP/JAR editor used to stamp a license into a plugin at download time. |
| `plugin/` | `LicenseClient` (drop-in, no deps) + an example Bukkit/Paper plugin (`mvn package`). |

## Products & integrated downloads

Drop your plugin **.jar** into the admin **Products** page. LicenseX then hosts a licensed download:

```
GET /download/<slug>?token=<secret>&user=<buyer id>&name=<buyer name>&nonce=<per-download>
```

On each download LicenseX looks up the buyer's license (creating it on their first download), stamps a
`licensex.json` (`{url, key, product}`) into the jar with `server/jarstamp.js`, and serves it. The embedded
plugin reads that file on first start (`LicenseClient.embedded()`), persists the key, and runs under it — no
config, no manual key entry. The `token` is a per-product secret so the jar can't be leeched from the raw URL;
regenerate it anytime in the admin.

**BuiltByBit:** set the resource's off-site/custom download URL to the **BuiltByBit URL** shown on the product
card — it already contains `user=%%__USER__%%&name=%%__USERNAME__%%&nonce=%%__NONCE__%%`, which BuiltByBit fills
in per buyer, so every buyer keeps one license across downloads. Opening the raw link with no buyer id gets a fresh
license each time. Assign a product to a group to give its buyers that group's server limit.

**One license per buyer, stable forever.** BuiltByBit fills in `%%__USER__%%` (the buyer's id) on every download.
LicenseX keys the license on *buyer + product*: user 1 gets the same license (and the same `/?key=` link) no
matter how many times they download, and user 2 gets their own, even from the same IP or device. IP and a device
hash are still recorded and shown in the admin ("other licenses from this IP"). A download with no buyer id (for
example someone opening the raw link) can't be matched to anyone, so it gets a fresh license. Licenses are per
product; a buyer of two products has two licenses. The plugin stores its key in `license.key`, so it never changes.

**Server limit** resolution: per-license override > group limit > global default (`-1` = unlimited).
Each running server is a persistent random instance id, so IP changes don't create duplicate slots.

**Plugin flow:** `POST /api/v1/validate` on start and every N minutes (admin setting, default **1 minute**). Denial codes:
`INVALID_KEY`, `LICENSE_BLOCKED`, `LICENSE_EXPIRED`, `LIMIT_REACHED`, `SERVER_DISABLED`, `SERVER_REMOVED`.
Removals/blocks reach a running server at its next check-in. Short outages are tolerated (72h grace in the example plugin).

**Everyone checks their own license.** Every license is its own key with its own server list. The plugin prints a
personal link on startup (`<your-url>/?key=LX-...`), and anyone can also enter their key on the home page.
Nobody can see another person's license without that person's key.

**Rules worth knowing**
- Admin-disabled servers keep their slot and the owner can't remove them (otherwise a ban is dodged by removing).
- Owner removal frees the slot immediately; the old instance is shut down on its next check-in and a restart registers it fresh.
- The license key is the credential for the public page. Lookups are rate limited; IPs shown to owners are masked.

## Prototype limits (not production yet)
- Plugin-side checks can be patched out of a jar; obfuscate/verify server-side features if that matters to you.
- Single admin password, in-memory rate limits, no HTTPS in-process, no email/OAuth.
- The BuiltByBit placeholder step is untested against a real BBB resource.

See `DESIGN_BRIEF.md` for the visual design handoff.
