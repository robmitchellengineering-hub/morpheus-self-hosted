# WordPress plugin: domain rules and the traps in them

## The shape of the thing
One plugin, three modules — Deploy, Store, SEO — plus pairing, updates and theme
export. Everything Morpheus sends is a signed POST to
`/wp-json/morpheus/v1/<module>`: HMAC-SHA256 over the **raw body**
(`Morpheus_REST::verified_body`), with an `at` timestamp inside a 5-minute skew
window. Unsigned GETs are `/status` (public, reports version and module
availability) and `/pair`.

## An older plugin answers "I do not have that" two different ways
* the route exists but the action does not → **400** `unknown_action`
* the route does not exist at all → **404** `rest_no_route`

Handling only the first shipped WordPress's raw "No route was found matching the
URL and request method" to an operator who needed "your plugin is too old,
update it". Check both, and name the version they are running.

## Prove a credential before storing it
`/status` is unauthenticated, so `signing: true` only means *a* secret is set —
not that it is ours. The cheap proof that works on every plugin version is a
signed POST to `/deploy` with a deliberately invalid commit: a verified signature
answers 400 `bad_request` (the commit is rejected after the signature is
checked), a wrong one answers 401. Nothing is deployed.

## Updates
The plugin registers WordPress's own update channel and verifies the download
against a SHA-256 published in the manifest. A package it cannot verify is
**refused**, not installed — the first version fell through to an unverified
install when the manifest was unreachable, which meant anything able to block
morpheus.nz downgraded the site. Sites below 0.5.3 have no channel, so their only
route is a manual upload.

## Installing by hand: "destination folder already exists"
WordPress's uploader refuses to overwrite an installed plugin unless it is told
to. The operator needs the **Replace current with uploaded** button on that same
error screen, or `wp plugin install <url> --activate --force`, or delete-then-
install — and deleting runs `uninstall.php`, which clears the plugin's own
settings (repo, secret, armed) even though the site's content is untouched.

## Rendering: only one thing may own the head
Two plugins emitting `<title>` and a meta description is worse than one. With no
third-party SEO plugin Morpheus emits the tags itself; with Yoast, Rank Math,
AIOSEO or SEOPress active it writes *that plugin's* keys and emits nothing. The
rule lives in one place (`Morpheus_SEO::owns_head`) because it is the kind of
thing that gets duplicated and then disagrees.

## Content rules worth keeping
* `read_content` turns block tags into a separator before stripping them —
  otherwise `</h2><p>` glues "properly" to "We", and a generator writes a title
  about the wrong thing.
* A cached page embeds the title, the description and the links, so every write
  purges the page/object cache; a read does not.
* `bulk_add_links` wraps a phrase that already exists **in a text node** — never
  inside a tag, an attribute or another link — and WordPress keeps a revision,
  which is the operator's undo.
* Theme export reads only the active theme: paths outside it are refused whatever
  they look like, text only, capped, and every skipped file is reported with a
  reason.

## Detecting WordPress at all
Every WP REST response carries `Link: <…/wp-json/>; rel="https://api.w.org/"`,
including the 404 for a route that is not there. That header is the reliable
signature; guessing from the response body told a real WordPress site it was "not
a WordPress site".

## Never update the plugin through Deploy

The Deploy module writes files on the site — but only files that exist in the
site's GitHub repo. Using it to make the plugin overwrite **its own source**
mid-request is how you get a half-updated plugin and a white screen, with a
manual upload as the only recovery. The plugin's own signed update channel
exists for this; Deploy is for the site's theme and content.

## Do not gate a feature on a third-party plugin's presence

The SEO module briefly rendered its fields behind `defined('WPSEO_VERSION')`, so
a site without Yoast showed **no SEO UI at all** — not a degraded one. The
correct shape is the one in `owns_head()`: detect the other plugin, then *drive
it* or *emit nothing*, and always render the panel (reporting who owns the head).
A hard gate on someone else's plugin turns "that integration is missing" into
"the feature does not exist", which is structural, not cosmetic.

## The JS↔PHP contract must be parsed, not assumed

Both halves are untyped and each ignores what it does not recognise: rename a
field on the JS side and the plugin silently no-ops; rename an action and it is a
silent `403`. So `verify-seo.mjs`, `verify-pairing.mjs` and
`verify-working-copy.mjs` **parse the field and action names out of the plugin's
PHP** and compare them with what the JS sends. A rename on either side now fails
a check instead of surfacing as a mystery at runtime.

## A stale opcode cache reports the old version

If Plugins shows `0.5.6` while the site's `/status` still says `0.4.5`, that is a
stale PHP opcode cache on the host, not a failed install — a cache clear fixes
it. The fix is on the host's side, so do not go looking for a plugin bug.

