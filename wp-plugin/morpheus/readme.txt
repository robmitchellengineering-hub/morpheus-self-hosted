=== Morpheus ===
Contributors: morpheusnz
Tags: deploy, git, seo, woocommerce, store
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.6.1
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
