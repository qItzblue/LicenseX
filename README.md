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
GET /download/<slug>?token=<secret>&nonce=<per-download>&user=<buyer>
```

On each download LicenseX issues a license for the `nonce` (new per download, stable on repeat), stamps a
`licensex.json` (`{url, key, product}`) into the jar with `server/jarstamp.js`, and serves it. The embedded
plugin reads that file on first start (`LicenseClient.embedded()`), persists the key, and runs under it — no
config, no manual key entry. The `token` is a per-product secret so the jar can't be leeched from the raw URL;
regenerate it anytime in the admin.

**BuiltByBit:** set the resource's off-site/custom download URL to the **BuiltByBit URL** shown on the product
card — it already ends with `&nonce=%%__NONCE__%%&user=%%__USERNAME__%%`, which BuiltByBit fills in per buyer,
so every buyer's download gets its own stable license. A buyer hitting the raw link with no nonce gets a fresh
license each time. Assign a product to a group to give its buyers that group's server limit.

**One license per download, stable afterwards.** Every download carries a unique nonce (BuiltByBit injects
`%%__NONCE__%%` and `%%__USER__%%` into the jar). On first start the plugin calls `POST /api/v1/claim` with it.
A new nonce always creates a new license, even from the same IP/device (IP and a device hash are recorded and
shown in the admin, with an "other licenses from this IP" list). The same nonce always returns the same license, and
the plugin stores it in `license.key`, so it never changes.

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
