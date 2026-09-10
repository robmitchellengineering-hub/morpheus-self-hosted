=== Morpheus ===
Contributors: morpheus
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.4.0
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
2. Settings → Morpheus: set the repo (`owner/repo`), branch, a GitHub
   token with Contents:read, and a deploy secret.
3. Give Morpheus the same secret and the endpoint URL shown on the settings
   screen.

== Endpoints ==

* `POST /wp-json/morpheus/v1/deploy` — signed (`X-Morpheus-Signature:
  sha256=<hmac>`), body `{ "commit": "<sha>", "reason": "...", "at": "<iso>" }`.
  Add `?dry=1` (or `"dry_run": true` in the body) to force a report.
* `POST /wp-json/morpheus/v1/rollback` — signed; restores the last deploy's
  snapshot.
* `POST /wp-json/morpheus/v1/store` — signed; body
  `{ "action": "create_product" | "update_product" | "set_stock" |
  "list_products" | "get_product" | "context" | "create_post", "data": {…},
  "at": "<iso>" }`.
* `GET /wp-json/morpheus/v1/status` — unauthenticated; reports version,
  deploy state, and whether WooCommerce is available.

== Changelog ==

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
