# LicenseX design brief

Paste this into Claude Design (or hand to any designer). The prototype works end to end; the current UI is a
functional first pass and should be redesigned to look **modern, sleek and polished**.

## Surfaces (all in `web/`)
1. **Public license page** (`index.html` + `portal.js`): hero, license key input, result with usage ring, status chip,
   group tag, server list with Remove. Must feel trustworthy and effortless for a non-technical Minecraft server owner. Mobile first.
2. **Admin panel** (`admin.html`, `admin.css`, `admin.js`): sidebar app with Overview (stats, chart, activity), Licenses
   (table, filters, detail drawer, create/edit dialog), Servers, **Products** (drag-and-drop jar upload, product cards
   with download URL + copy, counts, enable/disable, replace file, delete), Groups, Settings, Audit log, login.

3. **Pricing page** (`pricing.html`, `pricing.js`): hero, plan cards (one highlighted), feature grid, comparison table, FAQ, final CTA.
   Plans come from the API, so layouts must cope with 2-5 plans and long feature lists.
4. **Customer dashboard** (same `admin.html`, role-aware): Overview with plan usage meters, **Billing** (current plan, usage bars,
   change plan), and for the owner **Customers** and **Plans** pages plus a workspace switcher and a "viewing someone else's
   workspace" banner.
5. **Login page** (`login.html`): Google / Discord / GitHub buttons (currently letter badges: swap in the real logos).

## Direction
- Dark-first, restrained, high contrast, one confident accent (currently violet to sky gradient). Light theme optional.
- Linear / Vercel / Stripe dashboard quality: tight type scale, generous spacing, subtle borders and glow, smooth micro-interactions.
- A distinct brand mark and wordmark for "LicenseX" (the "X" tile is a placeholder).
- Empty states, loading skeletons, error states, destructive-action confirmations, toasts.
- Dense but never cramped admin tables; keyboard friendly; WCAG AA contrast.

## Constraints
- Keep it **vanilla HTML/CSS/JS, no build step**; tokens live in `:root` of `web/app.css`, so retheming is mostly editing those.
- Don't change API calls or element ids used by JS without updating the JS. Strict CSP: no inline `<script>`; fonts only from Google Fonts.
- Render user-provided text via `textContent` (the `h()` helper in `lib.js` already does).
