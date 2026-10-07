# Selling with LicenseX on BuiltByBit

How a buyer ends up with their own license, from purchase to the license page.

```
buyer downloads on BuiltByBit
   -> BuiltByBit POSTs the buyer's id + your secret to LicenseX
   -> LicenseX returns that buyer's license key (same key every time for the same buyer)
   -> BuiltByBit writes the key into the jar where %%__BBB_LICENSE__%% is
buyer starts the server
   -> plugin reads its key, registers the server, prints a personal link
buyer opens the link / the home page and manages their servers
```

> Where this comes from: BuiltByBit's "External license key" placeholder is documented on its anti-piracy
> placeholders wiki page and in third-party license-system guides. I couldn't open the BuiltByBit wiki itself
> while writing this, so the request fields below come from those guides. Do the **test download in step 7**
> before you sell anything; it proves the whole chain end to end.

## 0. Put LicenseX on the internet

BuiltByBit's servers have to reach LicenseX, so `http://localhost:3000` will not work for selling.

1. Get a small VPS (anything that runs Node 22.13 or newer) and a domain, e.g. `licenses.yourdomain.com`.
2. Copy the project there and start it (keep it running with `pm2`, `systemd`, or Docker):
   ```
   LICENSEX_ADMIN_PASSWORD=choose-a-long-password \
   LICENSEX_PUBLIC_URL=https://licenses.yourdomain.com \
   TRUST_PROXY=1 PORT=3000 node server/index.js
   ```
3. Put HTTPS in front. With [Caddy](https://caddyserver.com) the whole config is:
   ```
   licenses.yourdomain.com {
     reverse_proxy localhost:3000
   }
   ```
4. Back up the `data/` folder (it holds every license). Never share it.

Open `https://licenses.yourdomain.com/admin` and sign in.

## 1. Fill in your links

Admin -> **Settings** -> *Website & contact links*: site name, Discord invite, your BuiltByBit page, support
email, website. They appear on the public home page. Empty fields are hidden.

## 2. Make groups (optional)

Admin -> **Groups**, e.g. "Standard" with 1 server and "Premium" with 3. Then Settings -> *BuiltByBit
integration* -> *Group for BuiltByBit buyers* to choose which one new BuiltByBit buyers start in. You can still
change any individual license later.

## 3. Create the placeholder on BuiltByBit

1. Go to <https://builtbybit.com/placeholders/> while signed in as the creator.
2. Create a placeholder:
   - **Placeholder:** `%%__BBB_LICENSE__%%`
   - **Type:** `External license key`
   - **URL:** copy from LicenseX Admin -> Settings -> *BuiltByBit integration* (ends in `/api/v1/builtbybit/license`)
   - **Secret:** copy the secret from the same card
3. Make sure it is enabled for your resource (follow BuiltByBit's placeholder UI).

BuiltByBit sends a form POST with `user_id`, `resource_id`, `version_id`, `version_number` and your `secret`.
LicenseX checks the secret, finds or creates that buyer's license, and answers with just the key as plain text.
If LicenseX can't answer, BuiltByBit writes "Unable to acquire a license key automatically, please contact the
creator directly." into the jar, so watch the **Audit log** while testing.

## 4. Build your plugin with LicenseX inside

Copy `plugin/src/main/java/dev/licensex/client/LicenseClient.java` into your plugin and follow
`ExamplePlugin.java`:

- a constant `"%%__BBB_LICENSE__%%"` that BuiltByBit overwrites with the key;
- on enable, if it starts with `LX-`, save it with `client.useKey(...)`, then `validate(...)`;
- re-validate on the interval the server returns (default 1 minute) and disable the plugin if it is denied;
- set the default LicenseX address in your code/config to your real domain.

Build it (`mvn package` for the example) and keep the placeholder text in the jar you upload.

## 5. Upload and publish

Upload the built jar as your resource file on BuiltByBit as usual. Do not edit the placeholder text.

## 6. Add the link to your resource page

Tell buyers where to manage their license, e.g. in the description: "Check or manage your license at
https://licenses.yourdomain.com". The plugin also prints each buyer's personal link in their console.

## 7. Test it like a customer

1. Download your own resource from BuiltByBit.
2. Open the jar (it is a zip) and confirm the placeholder was replaced by a key like `LX-XXXX-XXXX-XXXX-XXXX`
   (search the class file in a text editor, or just run it).
3. Admin -> **Licenses**: a new license with owner "BuiltByBit #<your user id>" should exist.
4. Start a test server with the plugin. Admin -> **Servers** shows it; the console prints your link.
5. Download again: the **same** key comes back and no extra license is created.

If something is off: Admin -> **Audit log** shows `bbb.denied` (wrong secret) and each issued license.

## 8. Day to day

- **Block a pirate or refund:** Licenses -> open it -> Block (reason is shown to the plugin). Effective within a minute.
- **Raise one buyer's limit:** Licenses -> open it -> Edit / set limit.
- **Disable one server:** Servers -> Disable.
- **Buyer moved servers:** they remove the old one on the home page, or you do it in the admin.
- **Rotate the secret:** Settings -> *New secret*, then paste it into the BuiltByBit placeholder.

## Not on BuiltByBit?

Use the **Products** page to upload a jar and share its direct download link anywhere (Discord, your own site).
LicenseX stamps the buyer's license into the file on every download. Pass `?user=<buyer id>` to keep one license per
buyer; without it each download gets a new license.
