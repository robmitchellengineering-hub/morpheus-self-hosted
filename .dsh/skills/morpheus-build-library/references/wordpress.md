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

## The dock is printed by the plugin, and its token is a credential
`includes/class-dock.php` prints the dock's `<script>` tag on the site's own
pages, for a signed-in **administrator only** — the token it carries acts as the
owner, so a visitor or an editor receiving it is the whole risk. Before 0.8 the
tag was pasted into the theme by hand, and a theme update deleted it; that is
why valiantmusic.com.au's dock "just stopped appearing" with `plugin.js` and
`/embed` both answering 200 and nothing anywhere saying why. A theme cannot
delete a plugin, and the settings screen names the one reason it is not printing
when it is not.

Three rules live in that file and are asserted in `scripts/verify-dock.mjs`:
the printed attributes are exactly the ones `public/plugin.js` reads; the token
rule admits what `server/src/lib/widgetToken.js` actually issues; and
`DONOTCACHEPAGE` is set **after** the decision, never before it — set for every
response it would quietly make the whole site uncacheable. `public/plugin.js`
mounts one dock per page however many copies of the tag are present, because
sites that had the old theme snippet still have it.

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

## Site health and maintenance

The HEALTH surface shows what is wrong with a managed site and (eventually)
fixes it. The rules below were each learned by getting them wrong first.

**Run WordPress's own Site Health tests; do not reimplement them.**
`WP_Site_Health::get_tests()` returns ~34 direct tests plus whatever an active
plugin registers (WooCommerce adds ten). Two implementations would give two
answers to one question. Two traps, both of which killed the first attempt:

- The tests are written for the **admin screen** and call admin-only helpers —
  `get_test_wordpress_version()` reaches `get_core_updates()`. Without
  `require_once ABSPATH . 'wp-admin/includes/admin.php'` the FIRST test is a fatal
  undefined function, and under WASM/CLI that printed **nothing at all**: one line
  of output, no error, exit 255.
- A core test's `test` key is a method-name **suffix** (`php_version`,
  `is_in_debug_mode`), resolved to `get_test_<name>()`. Calling the string fatals.
  A plugin-registered test (WooCommerce) is a real callable. Handle both.

Report the six **async** tests as not-run, with the reason. WordPress runs them
from a logged-in browser; a signed server scan cannot. An absent test silently
omitted reads as a passing one.

**A health screen is believed, so: no score.** There is no honest way to weight a
missing PHP extension against an open registration form, and a number invites
optimising the number. Order findings worst-first and count them; nothing more.
Keep each finding's **source** (WordPress vs our own check) — presenting our
opinion as WordPress's verdict makes the real findings unreadable.

**Scanning and applying are separate permissions.** An owner who asked to be told
what is wrong has not asked us to change their site, so `scan_enabled` grants a
scan and nothing else. Nothing may infer the second from the first.

**A major core update is never automatic.** It is the one operation that can take
a working site away, and WordPress's own rollback only covers a failure *during*
an update — not "it worked and now the shop is broken". There is no setting for
it, and the guard asserts a smuggled `apply_core_major: true` changes nothing.

**"Monthly" is a wall-clock day, not a 30-day interval.** A fixed interval drifts
into the wrong day and skips February, so the cap is day 28 and the scheduler
ticks hourly asking a pure `isDue()`. Compare against the **scheduled instant**,
not "30 days ago", so a run missed while the server was down happens exactly once
on the way back. (The first version returned *next* month's instant as "the most
recent past one", which meant a missed month was never made up. The guard caught
it.)

**Check the age of "nothing to update".** WordPress asks wordpress.org twice a
day. A site whose cron or outbound requests are broken reports zero updates
forever — and is exactly the site that needs them. The age is part of the answer.

**A host that cannot write files cannot be updated by anyone.** Detect it
(`get_filesystem_method()`, `DISALLOW_FILE_MODS`, directory writability), say so
and stop. Never ask the operator for FTP or SSH credentials.


## CLEAN MY SITE

The health scan asks whether the site is well. CLEAN MY SITE asks the harder
question — what is on the server that nobody asked for — and it is a SEPARATE
scan with its own cache and its own button, because it checksums core, walks the
uploads tree and may download plugin packages. A scan that heavy must never run
because a panel opened.

The rules, each learned from getting it wrong first:

* **A check that PASSED must not cause a change.** An `auto` fix on a finding
  that reads `good` ("the debug log is not readable") has nothing to clean, so
  the one press applies `auto` findings that ASK for something. The single press
  is smaller than the registry, and that is correct.
* **A rename is not a quarantine if the new name is still served.** Moving a
  `.bak` to `wp-config.php.bak.morpheus-bak-…` inside the document root leaves it
  just as readable. The only honest test is to request the new URL too, and to
  REFUSE — putting the file back — when the host cannot be shown to deny it. On a
  server that ignores `.htaccess` that means refusing, which is the right answer,
  not a bug to work around.
* **The caller names a finding; the plugin chooses every path.** The app sends an
  id and nothing else, and each fix re-enumerates what to move from the plugin's
  own literal allow-list at the moment it runs. A cached scan is never the
  authority for a write.
* **An exclusion prefix must be slash-bounded.** Our own plugin directory is
  excluded from the recent-files list; without the trailing slash that prefix also
  matched any plugin whose directory merely STARTS with the same word, silently
  dropping real plugins from the check.
* **An identifier that is used and never imported passes every syntax check** and
  throws at the first request that reaches it. A guard can assert the import; the
  browser is what finds it.

## "Is this file being served?" is a byte comparison, never a status

The debug log is the second file whose *served* state decides a finding (the
first is the physical robots.txt). The rule is the same one, and it is now
shared: fetch the site's own URL and compare the bytes it returns with the bytes
on disk — `morpheus_bodies_match()` in `helpers.php`, called by
`Morpheus_Clean::debug_log_state()` and `Morpheus_SEO::robots_txt_state()`.

It is **not** the HTTP status and **not** the shape of the body. A host whose
front controller answers every path under `wp-content` with 200 and its own HTML
page — `try_files … /index.php`, a custom 404 that returns 200, a WAF
interstitial — serves a body for a file that is not there, and a WordPress error
page rendered while debugging contains the words "PHP Warning". The first
version of this check decided "readable" from 200 plus a log-shaped body and told
a live site's owner his log was leaking when his host answered a 12 KB HTML page
for filenames that did not exist.

The scan and the FIX call the same function on purpose: the owner's experience
was a scan that said `critical` and a fix that answered `NOT_SERVED` — two rules
for one fact, disagreeing in front of him. When the file exists but is not what
the URL serves, the honest verdict is `good` ("the log exists on disk and is not
being served over the web"), never "needs attention".

Morpheus also annotates WordPress's own `debug_enabled` Site Health test (which
says debug MODE is on). That appended sentence must be the VERIFIED answer: the
registry's static `does` is only a fallback, and the scan writes `action_does`
per finding (`Morpheus_Fixes::annotate()` prefers it). A static readability
claim appended to somebody else's test is how the false positive reached the
operator twice.

## A refusal must leave a record, or it reads as a broken button

`Morpheus_Fixes::apply()` records the LAST attempt per finding — outcome, code,
message, time — in one capped option (`morpheus_fix_attempts`), for **every**
mechanism including the refusals. Both scans return it on the finding
(`Morpheus_Fixes::attach_attempts()`), and the panel renders it on the row.

It is a record and never a claim, and the code says so rather than the prose:
only an explicit `done` (ok + verified + not restored + no error) reads as
success, an unknown outcome reads as a refusal, a later run REPLACES the earlier
record, and the finding's own status is untouched by it. The reason it exists:
a refused fix used to reset the panel to the same count with nothing on screen
saying why, so the operator pressed it several times and concluded the button
was broken.

## The harness seams for the debug-log rule

`pre_http_request` is the stub for both hosts: return the log's own bytes and
the finding fires; return the host's HTML page and it must not. The stub has to
be **stateful** — serve the file only while it is on disk, 404 after the fix
moves it — or the fix's own after-the-fact probe sees a "still serving" answer
and refuses, and the harness is then testing the stub. The dock rig has the same
fixture as a real route: `/wp-content/debug.log` plus a dev-only
`/__fixture/debug-log?mode=served|fallback&clear=attempts`, so the browser can
be driven across the scan→press boundary where the host changes its mind.

## The physical robots.txt section above, and this one, share a rule

Both were fixed by comparing served bytes; if a third file ever needs the same
question asked, use `morpheus_bodies_match()` and follow the shape in
`debug_log_state()` — one function that both the scan and the fix call, so the
two can never disagree about a live site.

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

## A link the plugin sends is rendered INSIDE the app, so it must be absolute

Every guided step in `class-fixes.php` carried a root-relative path
(`/wp-admin/users.php?role=administrator`). The panel renders the value straight
into an `href`, so the browser resolved it against **the app's own origin** —
morpheus.nz — and it hit the app's catch-all route: the operator clicking a link
to their own site got Morpheus's "Page Not Found / the AI hasn't implemented this
page yet" screen. Every guided instruction was a dead link, on every site.

Two rules now, because the plugin and the app ship separately and either half
alone would leave the window open:

* the plugin builds each link with `admin_url( … )` — which also respects a site
  whose wp-admin is not at `/wp-admin/`, which a literal path cannot — and
  `class-health.php` resolves a root-relative core action href against the site
  before forwarding it;
* the panel resolves any value still beginning `/` against the connected site's
  own URL (`src/lib/siteLink.js`), so an older plugin's payload or a new finding
  opens the customer's site instead of the app's 404.

`scripts/verify-clean-site.mjs` asserts both halves — it parses the `'link' =>`
values out of the PHP and behaviour-tests the resolver, and asserts the panel
actually calls it — and the plugin harness asserts the same links are absolute
and on the boot's own host. The defect was found by a person clicking, so the
dock rig (`scripts/dock-rig-drive.sh`) also reads the rendered href and requires
it to be the fixture site, never the app origin.

## A stale opcode cache reports the old version

If Plugins shows `0.5.6` while the site's `/status` still says `0.4.5`, that is a
stale PHP opcode cache on the host, not a failed install — a cache clear fixes
it. The fix is on the host's side, so do not go looking for a plugin bug.

## A physical robots.txt silently disables the whole robots filter

WordPress builds `/robots.txt` dynamically — core, plus
`Morpheus_SEO::filter_robots_txt()` — **only while no physical file exists**. A
real file always wins, the filter never runs, and nothing in wp-admin mentions
it. A file left behind by a removed SEO plugin therefore goes on advertising
`Sitemap: …/sitemap_index.xml` (404) while the sitemap the site actually serves
is never advertised — and the owner often cannot delete it, because the hosting
panel is held by somebody else. Hence the panel's **quarantine** fix: rename
`robots.txt` to `robots.txt.morpheus-bak-YYYYMMDDHHMMSS` beside it (never
delete), re-read the live `/robots.txt`, and rename it straight back if the site
does not come up serving WordPress's own.

The check is deliberately hard to trigger: it fetches the site's own
`/robots.txt` and compares those bytes with the bytes on disk, so a file that is
not being *served* is never reported, and a file that already advertises a live
sitemap is left alone. Two traps in judging staleness:

* a sitemap URL is live only if it answers **200 itself**. This plugin's own
  legacy-sitemap redirect turns the removed plugin's path into a 301, so a
  redirect-following check calls the very site that needs the fix healthy.
* the sitemap to compare against is **whatever the `robots_txt` filter chain
  emits**, never `home_url( '/wp-sitemap.xml' )`. Hard-coding ours makes every
  correctly-Yoast-configured physical file look stale — and the fix would then
  take a working robots.txt away.

## The Playground static-file race (harness only)

Once a physical `robots.txt` has existed in Playground's `/wordpress`, its
static-file router answers roughly **one `/robots.txt` request in five** with a
bare 500 ("Could not read /wordpress/robots.txt") — with a query string as well
as without, and before WordPress runs at all. A harness that asserts on the live
`/robots.txt` therefore has to retry (`morpheus_live_robots()` in
`tests/harness-noyoast.php`), and the plugin's own read retries too
(`Morpheus_SEO::fetch_robots_txt()`), because a single blip must not decide
whether a file in the site root is moved. A real host falls through to the front
controller.

## A theme change is not verified here, and must not read as clean

Morpheus's backend has no PHP, so the Deploy tab's check reads only the changed
JS/TS — while the change itself is usually PHP, CSS and template parts. That
leaves "no errors were found" over **zero** files, which is a pass from a check
that examined nothing (hazard H17). So the verdict has three states, not two:
`passed`, `failed`, and `not_verified` (report code 2, which is never a pass).

Only `failed` blocks the ship. `not_verified` ships and says so, because a
PHP-only theme edit is the normal case for this target and blocking it would
stop real work — and a gate that cries wolf gets switched off. The rule is
`coverageVerdict` in `server/src/lib/engine/verificationCoverage.js`, asserted by
`scripts/verify-verifier-coverage.mjs`; the UI must render the third state rather
than "0 script files clean".

The same reasoning says the *merge* cannot require a gate list invented here.
This target is a tenant repo, and the live one has no CI workflow and no
protected branch — requiring Morpheus's own gate names would refuse every merge.
`server/src/lib/delivery/wordpress.js` therefore requires exactly what the
connection declares in `PluginConnection.meta.requiredChecks` (the same place
`branch` and `healthPaths` live), and nothing otherwise.


