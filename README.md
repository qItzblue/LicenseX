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
| `server/jarstamp.js`, `classfile.js`, `wrapjar.js` | Dependency-free JAR editor, class-file patcher and the plugin wrapper that adds the license check. |
| `wrapper/` | Source of the precompiled wrapper classes (`wrapper/build.sh`). |
| `plugin/` | `LicenseClient` (drop-in, no deps) + an example Bukkit/Paper plugin (`mvn package`). |

## Products & integrated downloads

Drop your finished plugin **.jar** into the admin **Products** page. You don't change your plugin's code: LicenseX
**wraps** it so it checks its license before it starts (see `server/wrapjar.js`). On each download it looks up the
buyer's license (creating it on their first download), builds that buyer's copy, and serves it:

```
GET /download/<slug>?token=<secret>&user=<buyer id>&name=<buyer name>&nonce=<per-download>
```

How the wrapping works: `plugin.yml`'s `main:` is pointed at a small precompiled `Wrapper` class that **extends your
real main class**. `Wrapper.onEnable()` asks the LicenseX server whether the license and server are allowed and only then
runs your original `onEnable()`; a background check every minute disables the plugin if the license is revoked. The
wrapper classes are Java 8 bytecode in `server/wrapper/` (built from `wrapper/src` with `wrapper/build.sh`), so LicenseX
itself still needs only Node. Jars that can't be wrapped (final main class, `paper-plugin.yml`, no `plugin.yml`) are
reported on upload and their downloads are blocked rather than served unprotected. A plugin that already contains
`LicenseClient` (like `plugin/`) is served as is with its license file. `test/paper-e2e.mjs` proves the whole thing on a
real Paper server.

**Selling on BuiltByBit?** Don't use this link. Press **BuiltByBit build** on the product, upload that jar to
BuiltByBit, and let BuiltByBit's external-license-key placeholder (`POST /api/v1/builtbybit/license`) deliver each
buyer's key: **[docs/BUILTBYBIT.md](docs/BUILTBYBIT.md)** has the full step-by-step. The direct link is for
distributing outside BuiltByBit (Discord, your own site). Pass
`?user=<buyer id>` on that link to keep one license per buyer. Assign a product to a group to give its buyers that
group's server limit.

**One license per buyer, stable forever.** BuiltByBit sends the buyer's id (`user_id`) on every download.
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

See `DESIGN_BRIEF.md` for the visual design handoff and `docs/BUILTBYBIT.md` for going live on BuiltByBit.
