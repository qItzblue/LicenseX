# Roles, permissions and product-limited access

Every workspace (yours, and each customer's) has a **Team** page in the dashboard. There you design **roles** and give
people access with them.

- **Role** = a name plus a list of things its holders may do (see licenses, block licenses, upload plugin files, ...).
  You decide what is in it.
- **Person** = an email address, a role, and optionally a list of products.
- **Limited to products**: the person only sees and touches the licenses, servers and products that belong to those
  products. Everything else behaves as if it did not exist for them: it does not show up in lists, searches, counts
  or by guessing links.

The workspace owner always has everything. Nobody can change the owner.

## Adding someone

1. **Team -> + Add person**, enter their email, pick a role, and pick *All products* or *Only these products*.
2. Send them the sign-in link shown on the Team page (`/login/creator`). They sign in with Google, Discord or GitHub
   using **that email address**; the sign-in provider must have verified the address (an unverified address never counts).
3. They land in your workspace with exactly the access of their role. People who belong to several workspaces get a
   workspace picker in the sidebar.

Switch a person off to cut access immediately (they stay on the list) or remove them. Changes apply on their very next
request; there is no waiting for a session to expire.

## Designing roles

**Team -> + New role** shows every permission with a checkbox. Starter roles are created for you the first time you open
the page (Administrator, Support, Developer, Viewer); change or delete them freely.

| Permission | Lets them | Works for product-limited people |
|---|---|---|
| See licenses | open the Licenses page and license details | yes |
| Create licenses | make licenses by hand (a limited person must pick one of their products) | yes |
| Edit licenses | owner, note, server limit, expiry, group, buyer email, product | yes |
| Block and unblock licenses | block with a reason, unblock | yes |
| Delete licenses | delete one license, or clean up unused download licenses | yes |
| See servers | the Servers page | yes |
| Disable, enable and remove servers | manage servers | yes |
| See products and their download links | the Products page (shows the secret download link) | yes |
| Edit products | upload a new jar, rename, switch on/off, new download link, BuiltByBit resource id | yes |
| Create new products | add a product | no |
| Delete products | delete a product | yes |
| See license groups | read groups (and pick one on a license) | yes |
| Create, change and delete license groups | manage groups | no |
| See the activity log | the Audit log page | no |
| Change workspace settings | server limit default, heartbeat, the BuiltByBit secret and group | no |
| Manage roles and team members | the Team page | no |

"No" means the permission reaches across the whole workspace, so a person limited to products never gets it, whatever
their role says. Permissions that another permission needs come along automatically (editing licenses includes seeing them).

In the **site owner's own workspace** two more exist: *See and manage customers* (plans, suspend, invite) and *Edit the
public site name, tagline and links*. Running builds, backups, plan prices, Stripe and the list of admin emails always
stay with the site owner.

## Which license belongs to which product

Product limits work through the link between a license and a product:

- licenses issued by a product's **download link** are linked to that product automatically;
- licenses made by hand are linked by choosing a product in the license form;
- licenses **BuiltByBit** asks for are linked when the product knows its BuiltByBit resource id: open the product,
  **Edit**, and enter the number from the resource's address. Licenses issued earlier for that resource are linked at the same time;
- anything not linked to a product is only visible to people with access to *all* products.

## Guard rails

- You can only give out permissions you have yourself, and only change roles or people who do not have more access than you.
- Nobody can change their own access or remove themselves.
- At most 20 roles and 50 people per workspace.
- Every change is in the activity log with the email of the person who made it.
- Backups include roles, people and their product limits; a restore that would leave someone pointing at a role or product
  that is not in the backup is refused.
