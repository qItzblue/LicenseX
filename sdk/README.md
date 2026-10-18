# LicenseX thin-client SDK

Build plugins whose **paid features cannot be stripped**, because the code that runs them is served from your
LicenseX server and is never inside the jar. This is the strong protection (remote class loading + a signed channel),
packaged so you can repeat it for every new plugin.

> **What this is and is not.** This makes the *features you choose to serve* un-strippable: a cracked copy with the
> license removed never receives that code, so it simply cannot run. It does **not** make a jar "uncrackable" — local
> code in the jar is always strippable, and this cannot be auto-applied to an already-compiled plugin (the features are
> already baked in). You build the plugin this way *from the start*, with the plugin's source.

## The idea

```
plugin jar (ships to the buyer)        your LicenseX server (never ships)
--------------------------------       ------------------------------------
- license client                       - checks the license
- RemoteFeature interface              - holds ServerFeature (the real code)
- a stub that asks the server  ───────►  signs + sends the class bytes
- loads + runs what comes back ◄───────  (Ed25519, nonce-bound)
```

Strip the license and the stub has nothing to call, so the feature is gone — not unlocked, gone.

## Layout (`sdk/template/`)

```
src/main/java/com/example/myplugin/MyPlugin.java          the plugin (thin client)
src/main/java/com/example/myplugin/remote/RemoteFeature.java   interface only (ships in the jar)
src/main/java/dev/licensex/client/LicenseClient.java      the client (validate + remoteClass + feature)
server-src/com/example/myplugin/remote/ServerFeature.java the real logic (SERVER ONLY, never in the jar)
src/main/resources/plugin.yml, config.yml
build.sh
```

## How to build a plugin with it

1. Copy `sdk/template/` to a new folder and rename the package/ids.
2. Put **cheap/cosmetic** code in local commands (e.g. `mylocal`) — fine if it gets stripped.
3. Put the **valuable** logic in `server-src/.../ServerFeature.java` and call it from a stub command (e.g. `myfeature`).
   The stub fetches the class, loads it into memory, and runs it.
4. Build:
   ```
   ./build.sh
   ```
   This produces:
   - `target/MyPlugin-1.0.0.jar` — upload to LicenseX as a product (sell the BuiltByBit build / download link).
   - `server-out/*.class` — copy into your LicenseX server's remote class store: `server/prototype/remote/`.
5. The server already serves these at `POST /api/v1/class` (signed, license-gated). No extra server code needed.

## Rules of thumb

- **Serve what people pay for.** The more real logic lives in `server-src/`, the more a cracked copy is broken.
- **Don't serve per-tick/latency-critical code** — each call is a network round-trip. Use it for commands and
  occasional actions, not movement or particles.
- **Your server must be up.** Offline = those features don't work. Keep uptime high; the license client has a short
  offline grace, but remote features need the server live.
- **Keep the server logic non-trivial.** A one-line feature can be re-implemented by a determined attacker running
  their own server. Real value (data, computation, state) is what makes that not worth it.

## What you still get automatically (no SDK needed)

Every product uploaded to LicenseX — thin-client or not — gets the license check, the hardened wrapper (random names,
masked config, signed offline grace), per-buyer watermarking, and leak/seat detection. The SDK adds the one tier that
can't be stripped on top of that.
