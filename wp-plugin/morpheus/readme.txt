=== Morpheus ===
Contributors: morpheusnz
Tags: deploy, git, seo, woocommerce, store
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.9.11
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
* **Health** — what is wrong with the site, and the actions that fix it. Where a leftover physical
  `robots.txt` is being served instead of WordPress's own and it advertises a sitemap that 404s, the
  panel names the file it found and offers to **quarantine** it — the file is renamed to a
  timestamped backup beside it, never deleted, and put straight back if the site does not come up
  serving the right robots.txt afterwards.

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

= 0.9.11 =
* New: **three things WordPress does by default, and a switch for each.** None of these is a fault your site
  developed — they are how WordPress ships, on every site, and a person would have to know to go and close them.
  * **Stop publishing usernames to visitors.** WordPress answers `/wp-json/wp/v2/users` with every author's id,
    display name and slug, and resolves `/?author=1, 2, 3…` to each in turn. The slug is the login name on any
    site that never changed it. Morpheus refuses both to anyone who is not signed in; signed-in editing and
    `/wp/v2/users/me`, which the editor needs, are untouched.
  * **Stop announcing the WordPress version.** Every page carried `<meta name="generator" content="WordPress …">`
    in its head — the fastest way for anyone to find out whether a known vulnerability applies to you.
  * **Tell browsers to use HTTPS for this host.** Sends `Strict-Transport-Security` for six months, which closes
    the first-visit downgrade that a redirect cannot. Offered only on a site already served over HTTPS, and
    deliberately without `preload` or `includeSubDomains`: those outlive the site that set them.

= 0.9.10 =
* New: **the AI FIX button has a real choice in it now.** Two findings can be answered more than one honest way, and
  Morpheus offers the operations the site can actually perform and picks between them from what the check found.
  First: **Stop logging errors to a public file** — either turn `WP_DEBUG` off, or keep debugging and move the log
  outside the web root. Both are rails that already ship, so nothing new can be written to your site; the change
  is that Morpheus can now RECOMMEND one and say why. Nothing is applied until you have read the exact change and
  pressed APPLY, and it is never swept into FIX ALL.

= 0.9.9 =
* Fix: **the error log stops counting WordPress's own update run as your problems.** On a real site, 46 of the
  "100 distinct problems" the panel listed were WordPress updating itself — "Automatic updates starting…",
  "Upgrading plugin 'x'…", "Scraping home page…", and the delimiters core wraps its post-update error scrape in.
  Two causes, both fixed: the same line written in three different months was three separate groups (a month is
  letters, and only numbers were being treated as ids), and every one-off scrape hash was its own problem. Core's
  update run is now a single row you can skip. A **failed** loopback check is deliberately left out of that —
  it means core could not run the check at all, which you should see.
* Fix: the TRAFFIC tab said **"Sitemap hygiene is not built yet."** It was doing it. `robots.txt` is kept
  pointing at the sitemap the site really serves, a dead path left by a removed SEO plugin is replaced, and a
  stale physical `robots.txt` can be quarantined. The tab now names what it handles as well as what it does not.

= 0.9.8 =
* New: **READ THE WHOLE LOG.** The error log panel reads a bounded tail — the newest 400 lines of a file that can
  be gigabytes — because opening a panel must never pull the whole thing. That bound is there for the panel, not
  for you: press **READ THE WHOLE LOG** and Morpheus reads the entire file (up to 8 MB, and it says so when it
  stops short), and **COPY ALL** then copies the lot. The panel tells you which read you are looking at, because
  "8000 lines" means something different when you asked for all of them.

= 0.9.7 =
* Fixed: **Morpheus was telling search engines about pages that are not pages.** A real site's submission ledger
  came back with fifteen builder internals in it — `?elementor_library=default-kit`, `?cms_block=equipment-repair`,
  `woodmart_layout/product-archive-layout/` — plus `/cart/`, `/my-account/` and `/wishlist/`. A page builder
  registers its templates and blocks as *public*, which is the test this used; the question that matters is
  whether a URL has a single view at all, whether the site has asked to keep it out of search, and whether it has
  a real permalink. A permalink that comes back as nothing but a query string is the tell, and it is refused now.
* The store's own utility pages — cart, checkout, account, terms — are never announced, and there is a
  `morpheus_announce_url` filter for anything else (another shop, a membership plugin, a one-off thank-you page),
  because a list of slugs would be a guess.
* Fixed: **"the site was down" is no longer filed as a warning.** A handful of PHP messages mean the site could
  not serve a request at all — the database unreachable, memory exhausted, a request killed for running too long —
  and PHP writes them with the same words as the noise around them. A database outage on a real shop sat inside
  twenty routine warnings, invisible. They are raised above the noise now, and the ERROR LOG panel says in plain
  words what happened: *"PHP could not reach the database server. While this is happening WordPress answers every
  page with 'Error establishing a database connection' — visitors saw an error, not a slow site."*

= 0.9.6 =
* New: **AI FIX.** A finding that used to end in instructions can now end in a button. Press it and Morpheus
  works out what it would do, shows you the exact change in plain words, and **changes nothing until you press
  apply**. It is the answer to the findings that had no automatic fix: instead of a list of steps to hand to
  someone, you get a proposal you can read and accept.
* **The model does not get to invent anything.** The operations it may choose from live in the plugin — one per
  finding, each something this build can perform, verify and put back. The model picks one and fills in the
  arguments; the plugin checks the operation against the one that finding actually allows, and every argument
  against the site's own state (a timezone against PHP's own list, and against the timezone the site already
  reports) before a single file is touched. Anything else is a refusal that names itself.
* **Morpheus saying no is a real answer.** When the operation cannot honestly resolve the finding, it says so
  and explains what to do instead — and offers no button. Most findings on a WordPress site are fixed by a
  person, and that is a good outcome, not a failure.
* AI findings stay **guided**: they are never swept into a bulk fix, and applying one is always a separate press
  with the proposal on screen.
* First mechanism: **write the PHP timezone into wp-config.php**, for the site whose PHP clock disagrees with the
  WordPress clock it already set. It goes through the same rails as every other config edit — backed up first,
  written atomically, read back, and restored automatically if it does not verify.

= 0.9.5 =
* Fixed: **the error log can be copied.** The panel's rows were buttons, and selection is turned off on
  every button in this product (deliberately, so Android does not pop a highlight menu on controls) — so
  the evidence sat inside a control and could not be selected. The text opts back in, and the row still
  toggles anywhere.
* New: **COPY ALL**, which puts the whole readout on the clipboard as plain text — the file it was read
  from, how much of it was read, and every distinct problem with its count, its file:line and its own
  words. Useful on a phone, where dragging a selection across a hundred rows is not something anyone can
  do. It works on hosts and embeds where the clipboard API is unavailable, and says so when it cannot.
* Fixed: **the twelve problems you could not see.** The panel returned at most 40 distinct problems, and a
  real site's log had 52 — so a quarter of it was invisible with one grey line as the only hint. The cap is
  now 100, and it still reports when it bites.
* Fixed: the "more like this" line named `wp-content/debug.log` as where the full log lives — no longer
  true on any site whose log has been moved out of the web root (0.9.4). It names the real path.

= 0.9.4 =
* New: **Morpheus can move your error log out of the web root, in one press.** WordPress's standard debug block
  is `define( 'WP_DEBUG_LOG', true )`, and true means `wp-content/debug.log` — **inside** the site, where a web
  server hands it out as plain text to anyone who asks for it. Most hosts do. Until now Morpheus could only
  rename a log that was *already* being served, and WordPress recreates the file at the old path on the next
  warning, so that was a chore you repeated. HEALTH now reports a log that is written inside the web root
  **before** it is exposed, and offers to point `WP_DEBUG_LOG` at a file **beside** the site and move the
  existing log there. Nothing is deleted and debugging stays on: you keep the log, the web stops being able to
  reach it. Which is the point — a log is for you, not for whoever asks.
* It refuses, changing nothing, when it cannot **prove** the new location is outside the web root, when
  wp-config.php has no single `WP_DEBUG_LOG` line it can safely rewrite, or when a file already sits at the
  destination. The original wp-config.php is backed up first and restored automatically if the change does not
  read back; if the log will not move, the config goes back too.
* Fixed: the ERROR LOG panel now **follows `WP_DEBUG_LOG`**. It used to open `wp-content/debug.log`
  unconditionally and only *note* that WordPress was logging somewhere else, so a site that had already moved
  its log showed an empty panel. Moving a log without this would have blinded the reader it was moved for.
* The public-log check follows `WP_DEBUG_LOG` too, so a log pointed at some other path inside the site — which
  the check used to be blind to — is now reported like any other.

= 0.9.3 =
* Fixed: **a health finding that was Morpheus's, not your host's.** WordPress's REST API test attaches *your*
  login to a request the site makes to itself. Morpheus's scan is a signed request with no login, so that
  request arrived with no nonce, WordPress treated it as logged out by its own rule, and the test answered
  401 — on every site, whatever the host did. Morpheus reported it as "something is intercepting /wp-json/ —
  usually a security plugin or the host", which sent owners to their host and their security plugin about a
  finding we had made. It is now reported as **not run**, with the reason and where to answer it, and the
  check that *can* be answered from here — whether the site can reach its own REST API — is unchanged.
* Fixed: **the IndexNow key file was never served after an update.** Rewrite rules are read from an option
  that only a flush rebuilds, and WordPress does not run a plugin's activation hook when it **updates** it.
  A rule added in a release therefore never reached a site that updated into it: the key URL returned a 404,
  and the TRAFFIC tab was right to say "NOT confirmed served" while every line of the code looked correct.
  Rules are now flushed once per version, on the first request after an update — no Permalinks visit needed.
* Fixed: the key URL answers **200 directly**. WordPress's canonical redirect was answering it with a 301 to
  `/<key>.txt/` first, because it is not a page and not a file. The key handler now runs before it.
* Fixed: a key check that **failed** was cached for an hour, so fixing the rewrite left the panel saying it
  was still broken with nothing to say the answer was old. A failure is now re-asked within a minute; only a
  success is trusted for the hour.

= 0.9.2 =
* New: **redirects, and a 404 log.** Nothing in this plugin managed a redirect, and nothing recorded a 404:
  on a shop, every retired product URL, every renamed category and every campaign link someone already
  shared was a dead end that no one could see. Morpheus → WEBSITE now keeps a rule list (301, 302, 307 or
  a real 410 Gone) applied before the theme loads, and a log of what was asked for and not found, grouped
  by path so a thousand hits on one dead link is one row with a count.
* The 404 log is what tells you which rule to write, so the two are one feature rather than two reports.
* **Your admin is never redirectable.** A rule matching `wp-admin`, the login form, the REST API or cron is
  refused when it is saved *and* ignored when a request is matched — the one mistake here that could not be
  fixed from inside WordPress. A redirect to itself, and two rules pointing at each other, are refused too.
* The log is bounded, and when it is full it drops the **least-hit** entry: a scanner asking for a thousand
  unique paths cannot push out the URL forty visitors a day are hitting. It is throttled under a flood, so
  its counters are floors rather than exact totals — the panel says "at least" for that reason.
* Clearing the 404 log is allowed; it is Morpheus's own record of what it observed, unlike the site's PHP
  error log, which this plugin reads and never touches.

= 0.9.1 =
* New: **the site's error log, read rather than merely measured.** This plugin has always opened
  `wp-content/debug.log` — to decide whether your web server is SERVING it, by comparing its bytes with the
  URL's. That answers "is this file a leak" and nothing else: nothing read the errors themselves, so the
  question an owner actually has — what is going wrong on my site? — had no answer in Morpheus or in
  wp-admin. HEALTH → ERROR LOG now shows it: one row per distinct fault with a count, most frequent first,
  each row expanding to the raw log lines it saw, plus every line that was read.
* It is bounded to the newest part of the file — it seeks from the END and caps the bytes, the lines and the
  number of distinct faults — and it SAYS when it stopped short, so a truncated list can never be read as a
  complete one.
* Reading it changes nothing on the site, and there is deliberately **no button anywhere that clears,
  truncates or rotates the log**: an operator's evidence is not ours to delete.
* A missing log is reported as missing, an unreadable one as unreadable, and an empty one as empty — never
  as "no errors". WordPress only writes a log while `WP_DEBUG_LOG` is on, and an empty list would be the
  most dangerous possible reading of that.

= 0.9.0 =
* Fixed: **the SEO panel could not see the site's own content type.** The set of post types was the
  hard-coded `post`, `page`, `product`, so a site publishing a `services` custom type — reachable, in the
  sitemap, and getting head tags all along — had no way to list, audit or bulk-fill it. The live symptom:
  that page's meta description was its own first words including "Home / Services /", and nothing in the
  panel could say so. The types are now derived from what the site actually publishes: WordPress's PUBLIC
  post types, with attachments and WordPress's own internal public types excluded.
* The derivation follows the SITE's own `public` flag rather than second-guessing it. Measured on the live
  store: `/wp-sitemap-posts-services-1.xml` answers 200 (so `services` is public and is now listed) while
  `…-portfolio-1.xml` answers 404 — the theme registers its `portfolio` archive as **not public**, so it is
  deliberately left out of the panel and out of what gets submitted to an index.
* Fixed: **TRAFFIC announced only `post`, `page` and `product` to IndexNow**, so publishing anything else was
  never submitted. Both modules now read one shared list, so the two cannot drift apart.

= 0.8.9 =
* Fixed: **the site's own schema nodes were nested inside the page's.** Every page emitted its JSON-LD as
  `[{the page},[{Organization},{WebSite}]]` — a list inside a list, on every page of every site since 0.7.1.
  A consumer that flattens arrays of arrays (Google does) read it anyway; one that does not silently dropped
  both site nodes from every page. The three nodes are now siblings in one flat array. Nothing could see it
  before: the tests checked that the `@type` strings were present and that the block parsed, and a nested
  array satisfies both. There is now a test for the SHAPE, and a guard that fails in CI if it regresses.
* Fixed: **deleting the plugin left most of its settings behind.** Uninstall removed two options while five
  more survived — SEO templates, fix history, the pairing record, the traffic toggle — so a delete and
  reinstall inherited the previous site's configuration without saying so. It now removes every option the
  plugin stores and flushes the traffic rewrite rule, and a guard reads the option constants out of the
  plugin's own source so a new one cannot be forgotten.
* Fixed: **the traffic module was invisible to `/status`.** `Morpheus_Traffic::public_status()` was written to
  be "what the /status route adds" and was called from nowhere, so a build's IndexNow capability could only be
  discovered by making a signed call — while clean, SEO, store, export and pairing all report themselves there.
* Fixed: the TRAFFIC tab was missing from the list of tabs greyed out when no site is connected, so it looked
  usable and then answered "connect your site first".
* Fixed: the health-check path list was parsed twice, once inline in the deploy module and once in a Settings
  method that nothing called. One rule, one implementation.
* Updated: `Tested up to` said 6.8 while the plugin has been running on WordPress 7.1.

= 0.8.8 =
* Fixed: **a page-builder shortcode was being served as the meta description.** A product category's
  description is written in the page builder, so the stored value is `[html_block id="2419"]` — and the plugin
  stripped HTML without running shortcodes, so those literal characters reached `<meta name="description">`,
  `og:description` and `twitter:description` on `/product-category/backline/`, `/instruments/` and
  `/accessories/`. Shortcodes are now RENDERED before the text is taken, so the tag carries the sentence the
  description actually contains; an unknown shortcode is removed rather than printed. Archive descriptions are
  also cut to a search result's width on a word boundary.
* Fixed: **`/shop/` and its paged views had no meta description at all.** A post-type archive carries no
  description of its own, and the term → template → tagline chain had nothing to say, so the tag was omitted.
  The shop's own WordPress page — the one place that copy is written — is now a source, in the same order the
  SEO panel uses: the description set in Morpheus, then the excerpt, then the page body.

= 0.8.7 =
* Added: Morpheus now describes ARCHIVES too — the shop, product categories, tags and the blog index. Until now
  `emit_head()` returned early on anything that was not a single post, and on a site where Morpheus owns the
  head that meant those pages had NO canonical, NO description and NO social tags at all (measured live on
  `/shop/`: title 1, description 0, canonical 0, og 0, twitter 0).
* The canonical is the archive's own permalink WITH THE QUERY STRING STRIPPED, which is what collapses the
  `?orderby=`/`?filter_…` near-duplicates a WooCommerce archive generates, and a PAGED archive points at
  itself rather than at page one.
* The description comes from the term's own description, then the site-wide description template, then the
  site tagline — and if all three are empty the tag is omitted rather than invented.
* No `robots` tag and no schema on archives: the theme already emits both there, and a duplicate is the same
  defect this module exists to prevent.

= 0.8.6 =
* Fixed: the head emitted TWO `<link rel="canonical">` tags on every singular view — the plugin's own at
  `wp_head` priority 1 and WordPress core's `rel_canonical()` at priority 10. Two canonical tags are a defect
  even when they agree, because the day they disagree is the day the wrong URL gets indexed. The plugin now
  OWNS THE VALUE and core prints the tag: our canonical is handed to core through its own `get_canonical_url`
  filter and we print nothing ourselves. If core's callback has been removed, we print as before. A canonical
  set in the widget still wins.

= 0.8.5 =
* Fixed: **a false "publicly readable debug.log" finding.** The check used to
  conclude "readable" from the URL's HTTP status and the shape of the body. On a
  host whose front controller answers every path under wp-content with 200 and
  its own HTML page (`try_files ... /index.php`, a custom 404 that returns 200,
  a WAF interstitial), that reported a leak that was not there. The check now
  compares the bytes the URL returns with the bytes on disk, exactly as the
  robots.txt check already did, and a file that is not what the URL serves reads
  "good — the log exists on disk and is not being served over the web".
* Fixed: the sentence Morpheus appends to WordPress's own `debug_enabled` Site
  Health test no longer asserts the log is readable over the web. It reports the
  verified answer, and says so plainly when the question cannot be answered.
* Fixed: **a refused fix left no trace.** A fix that declined to act (the
  debug.log quarantine correctly refusing to move a file nobody is being served)
  rescanned to the same count with nothing on screen saying why, so a working
  refusal looked like a broken button. The plugin now records the last attempt
  per finding — outcome, code, message and time, in one capped option — the
  scan returns it with the finding, and the panel shows it on that row. A later
  successful run replaces the record, and a record never turns an unrun fix
  into a "done".

= 0.8.4 =
* Added: **CLEAN MY SITE** — a scan for the things only code on the server can
  see, and one press to quarantine what is safe to clean.
* It checksums every WordPress core file against wordpress.org, verifies
  wordpress.org-hosted plugins against the package the author published (bounded:
  a few packages, a few megabytes, and it says what it did not reach), lists
  every mu-plugin with its size and date, flags any .php file under uploads/,
  lists the accounts that can reach wp-admin, names scheduled hooks it cannot
  attribute, shows what changed on the site in the last week, and finds a
  publicly readable debug.log and any wp-config.php.bak / .env copy in the site
  root.
* **Nothing is ever deleted.** The three automatic actions rename the file with
  a UTC timestamp, name the backup on screen as the undo, and — where the file
  was being served over HTTP — request the URL again to confirm it stopped. If
  it is still served, the file goes straight back and the panel says so.
* A modified core file, a modified plugin file, an unknown admin account, an
  unattributed cron hook and a recently changed file are **reported, never
  applied**: re-downloading core over a live site, re-installing a plugin,
  removing an account and unscheduling a job are the owner's decisions.
* The scan is its own signed request with its own cache, so opening the panel
  never runs it. It reports what it skipped, and how far it got, whenever it hits
  a cap.
* Fixed: the health scan's `force` flag was accepted by the app and dropped by
  the plugin, so RESCAN returned a cached scan for five minutes.

= 0.8.3 =
* Added: **a site health check and a one-tap fix for a stale physical
  robots.txt.** WordPress only builds /robots.txt itself while no real file
  exists — a physical file always wins, so this plugin's own robots.txt filter
  never runs and nothing on the site mentions the file. When that file was left
  behind by an SEO plugin that has since been removed, it advertises a sitemap
  path that 404s while the sitemap the site actually serves goes unadvertised —
  and the owner usually cannot delete a file in the web root, because the
  hosting panel is often held by someone else.
* The check only reports the file when Morpheus can PROVE it is the one being
  served: it fetches the site's own /robots.txt and compares it with the bytes
  on disk, so a file that is not being served is never reported, and a file that
  already advertises a working sitemap is left alone.
* The fix **quarantines, it never deletes**: robots.txt is renamed to
  `robots.txt.morpheus-bak-YYYYMMDDHHMMSS` beside it, which is the owner's undo.
  Morpheus then re-reads the live /robots.txt and, if it is not WordPress's own
  with the correct sitemap line, renames the file straight back and says why.
* The health panel now states where a quarantined file went, by name, so the
  undo is visible rather than buried in a sentence.

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
