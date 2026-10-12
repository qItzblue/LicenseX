// Buyer accounts: a signed-in visitor (Google/Discord/GitHub) keeps all their licenses in one place ("My licenses").
// A license reaches a buyer in exactly two ways:
//   - they linked it themselves with its key (table buyer_links, keyed by "<provider>:<provider user id>"), or
//   - its creator issued it to an email address the buyer's provider has VERIFIED (licenses.buyer_email).
// reachable() is the one definition of that rule. Everything that reads or changes a license on a buyer's behalf goes
// through it, so a license id (or key) on its own never grants anything.
const MAX_LINKS = 100;    // licenses one account can link by key
const MAX_LISTED = 200;   // licenses shown on the account page
// Same words as the public lookup, so a wrong key and a malformed one look identical (and tell a guesser nothing).
const NOT_FOUND = 'License not found. Check the key and try again.';

export function registerBuyers(app) {
  const { route, db, core, HttpError, body, int, rateLimit, sessionUser, normalizeKey, KEY_RE, HOUSE } = app;

  // The email match ignores case, so give it an index that does too (otherwise every account page scans all licenses).
  db.exec('CREATE INDEX IF NOT EXISTS idx_licenses_buyer_lower ON licenses(lower(buyer_email))');

  const marks = n => Array(n).fill('?').join(',');
  /** A JSON body that is not an object (null, a number, a list) is treated as an empty one instead of crashing. */
  const input = async ctx => { const b = await body(ctx.req); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; };

  /** The signed-in buyer: a stable identity key (works even when the provider shares no email) and their VERIFIED emails. */
  function buyerOf(ctx) {
    const u = sessionUser(ctx.req);
    if (!u || !u.p || !u.id) throw new HttpError(401, 'Sign in first.');
    const emails = [...new Set((Array.isArray(u.emails) ? u.emails : []).map(e => String(e).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
    return { u, key: `${u.p}:${u.id}`, emails };
  }

  /**
   * The licenses this buyer may see, newest first (or just license `id`, if they may see it). Each row says HOW it was
   * reached: `linked` (they added the key) and `by_email` (issued to one of their verified emails).
   */
  function reachable(who, { id = null, limit = MAX_LISTED } = {}) {
    const mail = who.emails.length ? `lower(l.buyer_email) IN (${marks(who.emails.length)})` : '0';
    return db.prepare(`
      SELECT l.*, EXISTS (SELECT 1 FROM buyer_links b WHERE b.license_id = l.id AND b.user_key = ?) AS linked, (${mail}) AS by_email
        FROM licenses l
       WHERE (l.id IN (SELECT license_id FROM buyer_links WHERE user_key = ?) OR ${mail}) ${id == null ? '' : 'AND l.id = ?'}
       ORDER BY l.created_at DESC, l.id DESC LIMIT ?`)
      .all(who.key, ...who.emails, who.key, ...who.emails, ...(id == null ? [] : [id]), limit);
  }
  /** One license by the id in the URL, only if the buyer may see it. Anything else (including junk) is simply "not found". */
  const reach = (who, rawId) => (/^\d{1,12}$/.test(rawId) ? reachable(who, { id: Number(rawId) })[0] : undefined);

  const productName = db.prepare('SELECT name FROM products WHERE id = ? AND workspace_id = ?');
  const workspaceName = db.prepare('SELECT name FROM workspaces WHERE id = ?');
  /** What the account page shows for one license: the public portal view plus product, developer and how the buyer got it. */
  function entry(l) {
    const developer = l.workspace_id === HOUSE ? core.getSetting('site_name') : workspaceName.get(l.workspace_id)?.name;
    const product = (l.product_id != null && productName.get(l.product_id, l.workspace_id)?.name) || l.product || '';
    return { id: l.id, ...core.portalView(l), product, developer: developer || '',
      public_removal: core.getSetting('public_removal', l.workspace_id) === '1', via: l.by_email ? 'email' : 'key' };
  }
  const tooMany = () => new HttpError(429, 'Too many attempts. Try again in a minute.');

  route('GET', '/api/account', async ctx => {
    const who = buyerOf(ctx), u = who.u;
    return [200, { user: { name: u.name, email: u.email || '', avatar: u.avatar || '', provider: u.p }, licenses: reachable(who).map(entry) }];
  });

  // Add a license to the account by its key. The key is the credential (as on the public lookup page), so this is
  // rate limited per account and per address, and a wrong key answers exactly like the public lookup does.
  route('POST', '/api/account/licenses', async ctx => {
    const who = buyerOf(ctx);
    if (!rateLimit('acct-link:' + who.key, 15, 60e3) || !rateLimit('acct-link-ip:' + ctx.ip, 40, 60e3)) throw tooMany();
    const key = normalizeKey((await input(ctx)).key);
    const lic = KEY_RE.test(key) ? core.q.licenseByKey.get(key) : null;
    if (!lic) throw new HttpError(404, NOT_FOUND);

    const have = reachable(who, { id: lic.id })[0];
    if (have) return [200, entry(have)];                       // already in the list (linked, or issued to their email)
    if (db.prepare('SELECT COUNT(*) n FROM buyer_links WHERE user_key = ?').get(who.key).n >= MAX_LINKS)
      throw new HttpError(409, `You can add up to ${MAX_LINKS} licenses by key. Remove one you no longer need first.`);
    db.prepare('INSERT OR IGNORE INTO buyer_links (user_key, license_id, created_at) VALUES (?,?,?)').run(who.key, lic.id, app.now());
    return [201, entry(reachable(who, { id: lic.id })[0])];
  });

  // Take a license off the account. The license itself (and its servers) is untouched.
// Linking and unlinking are deliberately not written to the creator's audit log: it would tell them nothing they can act on,
// and a buyer could flood it by linking and unlinking in a loop. Removing a server is logged (by core.ownerRemove), as on the public page.
  route('DELETE', '/api/account/licenses/:id', async ctx => {
    const who = buyerOf(ctx), l = reach(who, ctx.params.id);
    if (!l) throw new HttpError(404, 'License not found.');
    if (!l.linked) throw new HttpError(409, 'This license was issued to your email address, so it always shows up here and cannot be removed from your list.');
    db.prepare('DELETE FROM buyer_links WHERE user_key = ? AND license_id = ?').run(who.key, l.id);
    return [200, { ok: true }];
  });

  // Free a server slot. Exactly the rules of the public page (core.ownerRemove): the developer can switch removal off,
  // and a server an admin disabled cannot be removed.
  route('POST', '/api/account/licenses/:id/remove-server', async ctx => {
    const who = buyerOf(ctx);
    if (!rateLimit('acct-remove:' + who.key, 30, 60e3)) throw tooMany();
    const l = reach(who, ctx.params.id), b = await input(ctx);
    if (!l) throw new HttpError(404, 'License not found.');
    const r = core.ownerRemove(l, int(b.serverId, { min: 1 }));
    if (!r.ok) throw new HttpError(409, r.message, r.code);
    return [200, entry(reachable(who, { id: l.id })[0])];
  });
}
