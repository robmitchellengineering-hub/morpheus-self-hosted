=== Morpheus ===
Contributors: morpheusnz
Tags: deploy, git, seo, woocommerce, store
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.8.2
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Run your WordPress site from Morpheus — deploy code, manage products and content, and own your SEO.

== Description ==

Morpheus connects this site to the Morpheus app (morpheus.nz) with a signed request, so the site's
owner can work on it from anywhere — including a phone — without handing over WordPress passwords or
FTP details.

**Connect in one step.** After activating, open Settings → Morpheus. It shows a short code (valid for
20 minutes, usable once). Type the code into Morpheus and the two are connected: the plugin generates
the shared secret, so nothing is invented or copied by hand.

**What it does once connected**

* **Deploy** — Morpheus opens a pull request against the repository your theme lives in. When the
  checks pass and it is merged, this plugin applies exactly the files that commit changed, checks the
  site still answers, and rolls the change back if it does not. WordPress core, other plugins and your
  uploads are never touched (enforced by a hard deny-list in the plugin).
* **Store** — products, stock, prices and content, managed from the Morpheus panel. WooCommerce
  optional; pages and posts work without it.
* **SEO** — read and write the title, meta description, focus keyword, canonical, social image and
  noindex for any page, post or product, list content, and audit the site for real problems. Works
  with NO other SEO plugin installed (Morpheus emits the tags itself) and, when Yoast, Rank Math,
  All in One SEO or SEOPress is active, drives that plugin's own fields instead — two plugins never
  emit competing title or description tags. Site-wide title/description templates fill the gaps, and
  internal links can be proposed and applied to a phrase that already exists in the text.
* **Working copy** — if the theme is not in a repository yet, the plugin can hand its own theme over
  so one can be created for you. Text files only; images and fonts stay on the site, where they are
  served from.
* **Dock** — the floating Morpheus button, on your own site, for you only. Switch it on in Settings →
  Morpheus and the plugin prints it on every page you open while signed in as an administrator; a
  visitor, an editor or a shop manager never receives it. It is a plugin feature rather than a
  snippet pasted into your theme, so a theme update cannot take it away.

**Updates.** This plugin registers the standard WordPress update channel, so it updates from your own
Plugins screen — and the download is verified against a published SHA-256 before it is installed.

== Installation ==

1. Upload `morpheus-wordpress-plugin.zip` via Plugins → Add New → Upload Plugin, and activate it, or
   with WP-CLI: `wp plugin install https://morpheus.nz/morpheus-wordpress-plugin.zip --activate`
2. Open Settings → Morpheus and copy the code it shows.
3. In Morpheus, open your project → WEBSITE → SETUP, enter your site address, and paste the code.

== Frequently Asked Questions ==

= Does it need my WordPress password? =

No. The connection is a shared secret generated during pairing, and every request is signed with it.

= Do I need another SEO plugin? =

No — but if you have one, this plugin uses its fields rather than emitting a second set of tags.

= Will it overwrite my site? =

A deploy only ever writes the files a merged commit changed, refuses a fixed deny-list (wp-config.php,
uploads, cache, .git, .htaccess, .env), snapshots what it touches, and rolls back if the site stops
answering a health check.

== Changelog ==

= 0.8.2 =
* Added: **one-tap dock setup.** The owner's Morpheus account can now switch the
  dock on at the site itself, over the same signed channel the other site
  operations use, instead of copying an embed token out of WEBSITE -> EMBED and
  pasting it into Settings -> Morpheus by hand. That copy-and-paste is a person
  carrying a credential between two screens, which is both how a live token ends
  up somewhere it should not and the step that goes wrong on a phone.
* Added: a signed `POST /wp-json/morpheus/v1/dock` route taking `get` and `set`,
  validating the pushed token with the same rule the settings screen uses, and
  returning the site's own verdict. The response never contains the token.

= 0.8.1 =
* Fixed: **a failed update no longer leaves the site unable to update.** When the
  download did not match the checksum this site was holding, the plugin kept
  holding it — so the retry its own error message asked for compared the same
  package against the same stale checksum and failed identically, every time.
  WordPress's "Check again" does not clear the plugin's cache either. The held
  checksum is now dropped the moment it fails to match, so pressing Update again
  really does check against the current one. The verification itself is
  unchanged: nothing installs without matching what the manifest says now.
* Fixed: the refused update's message now says which checksum the SITE was
  holding and which the package has, and that the held one has been cleared.

= 0.8.0 =
* New: **the plugin prints the Morpheus dock itself**, so it survives a theme
  update. Until now the only way to get the floating Morpheus button onto a site
  was to paste its `<script>` tag into the theme (or a snippets plugin) by hand.
  A theme update deletes that, and the dock then simply stops appearing — with
  nothing on the site or in wp-admin saying why. Turn it on in Settings →
  Morpheus, paste the embed token from Morpheus → WEBSITE → EMBED, and the plugin
  prints the tag on every page **for a signed-in administrator only**. A visitor,
  a subscriber, an editor or a shop manager never receives it, because the token
  it carries acts as the owner. A page that carries the token is also opted out of
  the page cache, so a cached copy can never be served to someone else.
* New: Settings → Morpheus says whether the dock is printing, and the one reason
  it is not — switched off, no token, a token that is not an embed token, or an
  address that is not `https://`. A screen that says "ready" while nothing is
  printed is how the original problem cost an afternoon.
* Fixed: the dock mounts **once** even where the old hand-pasted snippet is still
  in the theme alongside the plugin's own tag. Two tags used to mean two floating
  buttons.

= 0.7.1 =
* Fixed: **the site's own schema entity now actually exists.** `emit_schema()`'s
  doc-comment claimed it emitted "the site's own organization node on every page"
  and it did not — with an SEO plugin gone, a site could end up with a page node
  and no site entity at all. Every page now carries an `Organization` node (site
  name, URL, and a logo only when a real Site Icon is set) and a `WebSite` node
  with the `SearchAction` that powers a sitelinks search box. Every field traces
  to a real WordPress setting; there is no invented `sameAs`, rating or price.
* Fixed: the doc-comment above `emit_schema()` now describes what the code emits.
* Deliberately **not** added: a `LocalBusiness`/`Store` node. An accurate one
  needs an address, phone and opening hours, which WooCommerce's store options do
  not hold — a partial storefront entity is worse than none, and themes commonly
  emit a complete one already. See the schema rules in the build library's seo card.

= 0.7.0 =
* New: **IndexNow on publish.** When a post, page or product goes live — or a live
  one changes — the site tells IndexNow about the URL, which covers Bing and
  Yandex without an account, an OAuth app or a third party holding a key. The
  submission is scheduled rather than sent during the save, so publishing never
  waits on a third party and a failure never appears as an error on the site.
  Off by default: turn it on in the TRAFFIC tab.
* New: **a submission ledger.** Every submission is recorded with its UTC time,
  URL, action and the HTTP status IndexNow actually returned, capped at the last
  500 rows. A traffic feature that cannot show what it did is a claim, not a
  record.
* New: **`/traffic` endpoint** with `status`, `ledger`, `backfill` and `settings`.
  Backfill submits the site's existing published URLs in bounded batches and skips
  anything already accepted, so pressing it twice is safe.
* New: the plugin generates and serves its own IndexNow key file. Whether the
  host's rewrite rules actually serve it is CHECKED rather than assumed, and the
  tab says so plainly when they do not — a key that is not served means a
  submission that will be rejected.

= 0.6.4 =
* Fix: a site could be told there was no update when there was one. The published
  manifest is cached to keep wp-admin fast, and nothing could refresh that cache —
  so a site that read it before a release kept being told "nothing newer", and
  WordPress's own "Check again" re-ran the check against the same cached answer.
  Measured in a real WordPress: with a stale cache the offer is absent, a forced
  check finds nothing, and only clearing the cache shows the update. The cache is
  now an hour, and a signed `/updates` action clears it and re-runs the check.
* New: `/updates` reports what is actually true — the installed and published
  versions, the published checksum, whether WordPress is now offering the update,
  and, when the update server cannot be reached, the REASON. A check that cannot
  ask must never answer "nothing available".
* `/updates` only checks. It cannot install: the request that would apply this
  plugin's own update is served by the code being replaced, so WordPress's
  own updater — which stages the package and swaps it in — stays the only writer.
  Any other action is refused.

= 0.6.3 =
* New: every health finding now carries an ACTION. A signed `/fix` endpoint applies
  one, and the scan reports `unmapped` — any finding that asks for something and
  has no action registered — so a new WordPress test cannot quietly become a
  description with nothing to press.
* Fixes Morpheus can do itself, each backed up, verified, and put back if the
  verification fails: the wp-config defines for the file editor and error display,
  `blog_public`, the default registration role, WordPress's own update backup
  directory, and the overdue scheduled tasks.
* Host-level findings (PHP version and extensions, database, SSL, disk, loopback
  and outbound requests) carry step-by-step instructions with links and a re-check,
  because no plugin can change them from inside WordPress.

= 0.6.2 =
* Morpheus no longer appears as a target of its own maintenance engine. The
  request that would apply the update is served by the code being replaced, so a
  failure part-way through could leave the plugin half-written — and take with it
  the panel you would use to fix it. It is reported as available with that
  explanation, and `apply` refuses it outright; update it from Dashboard →
  Updates, as with any other plugin.

= 0.6.1 =
* New: a signed `/maintenance` endpoint. `plan` reports what could be updated
  (and refuses anything it cannot do safely); `apply` updates the targets it is
  given, one at a time.
* Every update is reversible or it does not happen: a plugin or theme is zipped
  into `wp-content/uploads/morpheus-backups/` before it is touched, the new
  version is verified afterwards, and a failed or unverified update is restored
  from that snapshot. If the host has no zip extension, or the backup directory
  cannot be written, Morpheus updates nothing and says why.
* A MAJOR WordPress version update is never applied — it is reported for a human.
  Minor and security updates are applied only when the owner has allowed them,
  and only when WordPress's own temporary-backup directory is writable.
* Snapshot paths are resolved and checked against their plugin/theme root, so a
  crafted target cannot read or write outside it.

= 0.6.0 =
* New: a signed `/health` endpoint that runs WordPress's own Site Health tests
  (plus WooCommerce's, if active) and reports the results, the available plugin,
  theme and core updates, the auto-update settings, and whether this site can
  have its files written at all. The Morpheus panel shows it as a HEALTH tab.
* The scan caches itself for five minutes, so opening the panel does not re-run
  it; the first scan of a site takes a few seconds because WordPress's tests
  include loopback HTTP requests.
* Six of WordPress's Site Health tests are asynchronous and are run from the
  browser by a logged-in administrator. A signed server scan cannot run them, so
  they are listed as not-run with the reason rather than omitted — an absent
  test must not read as a passing one.
* The scan is read-only apart from its own cache. Applying updates is not part
  of this release.

= 0.5.6 =
* Plugin details now explain the connection and what a deploy may touch.
* Update instructions and pairing guidance clarified.

= 0.5.5 =
* Export the active theme as a text-only working copy, so a site that is not in git can still use the
  full build and deploy pipeline.

= 0.5.4 =
* Pairing codes: connect with a one-time code from Settings → Morpheus instead of inventing and
  retyping a shared secret.

= 0.5.3 =
* One-click updates through WordPress, with the package verified against a published SHA-256.

= 0.5.2 =
* Site-wide title and description templates; internal-link suggestions; page-cache purge after writes.

= 0.5.1 =
* read_content, so generated SEO is grounded in the page's real text.

= 0.5.0 =
* The SEO module: Morpheus owns the site's SEO with or without another plugin.

= 0.4.0 =
* The Store module.

= 0.1.0 =
* The Deploy module.
