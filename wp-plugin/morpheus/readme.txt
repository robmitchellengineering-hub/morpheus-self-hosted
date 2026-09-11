=== Morpheus ===
Contributors: morpheus
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.4.4
License: GPLv2 or later

Run your WordPress/WooCommerce site from Morpheus — deploy code from a connected GitHub repo (no FTP), and manage products, stock and content over a signed API.

== Description ==

One plugin, two modules, one shared signed-request auth (HMAC-SHA256 over
the raw body, verified against a secret set here and on the Morpheus side).

**Deploy** — Morpheus builds changes through chat, opens a pull request on
your connected repo, and once its checks pass and the PR merges, calls the
deploy endpoint. The plugin diffs the merge commit, snapshots what it
touches, writes the changed files, health-checks the site, and restores the
snapshot if anything breaks. It never touches wp-config.php,
wp-content/uploads, cache directories, .git, .htaccess, or .env — that
deny-list is enforced in the plugin's own code, independent of .gitignore.

**Store** — a signed endpoint for WooCommerce and content actions (create a
product, set stock, update a product, draft a post), so you can run the
shop from your phone through Morpheus. Products are created as drafts unless
you say otherwise. Requires WooCommerce for the product actions.

= Arming =

Off by default: the deploy endpoint reports what a deploy *would* change
and writes nothing. Use that to connect the repo, set the shared secret,
and confirm the diff looks right. Tick "Armed" in settings to let a deploy
request write files — it snapshots what it touches, writes the changed
files, health-checks the site, and restores the snapshot automatically if
the health check fails.

== Installation ==

1. Upload the `morpheus` folder to `wp-content/plugins/` and activate.
2. Settings → Morpheus: set a signing secret (any random string, 12+
   characters). This alone enables the Store module.
3. In Morpheus, open the STORE panel, enter this site's URL and the same
   secret, and connect.
4. For the Deploy module as well: also set the repo (`owner/repo`), branch,
   and a GitHub token with Contents:read, and keep "Armed" off until you've
   reviewed a dry-run diff.

== Endpoints ==

* `POST /wp-json/morpheus/v1/deploy` — signed (`X-Morpheus-Signature:
  sha256=<hmac>`), body `{ "commit": "<sha>", "reason": "...", "at": "<iso>" }`.
  Add `?dry=1` (or `"dry_run": true` in the body) to force a report.
* `POST /wp-json/morpheus/v1/rollback` — signed; restores the last deploy's
  snapshot.
* `POST /wp-json/morpheus/v1/store` — signed; body
  `{ "action": "create_product" | "update_product" | "set_stock" |
  "delete_product" | "list_products" | "get_product" | "context" |
  "create_post" | "list_pages" | "get_page" | "create_page" | "update_page" |
  "delete_page", "data": {…}, "at": "<iso>" }`.
* `GET /wp-json/morpheus/v1/status` — unauthenticated; reports version,
  deploy state, and whether WooCommerce is available.

== Changelog ==

= 0.4.4 =
* Store: `seo_title` / `seo_description` fields on `create_product`,
  `update_product`, `create_page`, `update_page` — writes Yoast SEO's own
  postmeta (`_yoast_wpseo_title` / `_yoast_wpseo_metadesc`) when Yoast is
  active, no-op otherwise. `get_product` and `get_page` return the current
  values; `context` reports `seo_available` so the panel knows whether to
  show the fields.

= 0.4.3 =
* Store: page actions — `list_pages`, `get_page`, `create_page`, `update_page`,
  `delete_page`. Plain WordPress content, no WooCommerce required. Pages are
  DRAFT by default on create, same as products and posts. Cache purged after
  any write.

= 0.4.2 =
* Store: `delete_product` action — trashes a product by id or sku (reversible
  from wp-admin; `force:true` deletes permanently). Lets the operator retire
  a listing from Morpheus instead of the WordPress admin.
* Store: `update_product` can flip status (publish ↔ draft), so a listing can
  be unpublished without deleting it.
* Store: `get_product` now returns the product's brand terms, so an edit form
  can pre-fill them.

= 0.4.1 =
* Store: purge WooCommerce product transients + the page cache (WP Rocket,
  W3TC, WP Super Cache, SiteGround, LiteSpeed, WP-Optimize) after a product
  or post is created/updated, so it shows on the shop and category archives
  right away.

= 0.4.0 =
* Store module: /store endpoint for WooCommerce product + content actions.
  Products created as drafts by default; image sideload from URLs; brand +
  category taxonomy handling.

= 0.3.0 =
* Renamed to "Morpheus"; deploy code moved into a Deploy module; one shared
  signing secret.

= 0.2.0 =
* Armed deploy: snapshot, write, health-check, auto-rollback. Rollback
  endpoint. Blob-sha verification on every written file. Snapshot pruning.

= 0.1.0 =
* Initial release. Settings screen, signed deploy endpoint, dry-run diff.
