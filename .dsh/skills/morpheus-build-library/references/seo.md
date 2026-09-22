# SEO: what Morpheus may claim, and what it must not

## One owner for the head
Duplicate `<title>`/description tags are actively harmful. `owns_head()` is the
single decision: Morpheus emits the tags itself when no third-party SEO plugin is
active, and drives Yoast / Rank Math / AIOSEO / SEOPress's own keys when one is —
emitting nothing itself. The panel reports which, because "who is producing this
tag" is the first thing to check when a title will not change.

**A template is only real where Morpheus emits.** With another plugin active,
ours decides nothing about the rendered page, so the effective value must not be
reported as ours (that is a lie about the live site) — the explicit
"apply to existing items" path exists for exactly that case.

## An audit measures what goes out
Issues are derived from the *effective* title and description, so a value supplied
by a site-wide template is not "missing". Every finding is unambiguous and
actionable: missing, too long, too short, duplicated, noindex on live content,
thin content, keyword absent from the title. No vague "SEO score" — a score that
cannot say what to change invites optimisation theatre.

## Length limits are guidance, not scissors
The plugin publishes its limits and the UI counts against them. Generated text
over the guideline is **flagged**, not silently trimmed to fit: cutting a phrase
mid-word is not a favour. Hard ceilings exist only for the absurd.

## Internal linking is a live-content write, so it refuses far more than it
## accepts
The anchor must exist verbatim in the item's own text, in a text node, not inside
an existing link, the target must be one of the site's own pages, and a URL
already linked is refused. `dry_run` returns the exact sentence before and after,
and WordPress keeps a revision — that is the undo.

## Keyword research signals
Real: Google autocomplete, a competitor page's own title/description/headings, the
page itself, and — when the account has connected it — the site's **own Search
Console queries**, which are the only *measured* demand in the list and carry
Google's own impressions, clicks and average position on the row. Labelled per row
(`people type this`, `competing page`, `this page`, `AI idea`,
`your Search Console`) because the weakest signal must not look like the strongest.

Seeds come from the page, the operator, the model, and — since 2026-09-22 —
competitor phrases **through `isChrome()` and the word caps, never around them**.
The earlier ban on competitor seeds was the wrong fix for the "form name meaning
in hindi" incident: the chrome filter was already the right one, and it is what
`researchSeeds()` uses to decide.

## Relevance is not "shares a word with the page"
A candidate is kept only if it carries **two of the page's distinctive terms** —
its title's content words, its own target keyword, and body words repeated at
least twice. Counting any shared word instead is what makes a keyword list look
broken: on a page about guitar repairs, every one of `guitar center`,
`guitar hero`, `guitar tab` and `how to play guitar` shares exactly one word
("guitar") and would pass a single-word test. Asserted in
`scripts/verify-keywords.mjs` with that exact fixture, so weakening the gate to
one shared term fails CI.

Two fallbacks, both load-bearing: a page with fewer than three distinctive terms
asks for **one** shared term (a thin page cannot support a two-term test), and a
page that could not be read at all — a bare `body.seed` exploration — is **not
gated**, because dropping every candidate would report "no keywords" for a page
nobody ever read. The operator's own seed, their page's keyword/title, and
measured Search Console queries are never gated: they are not inferences about
the page.

## Search Console is where the real numbers come from

Keyword research deliberately shows no volume, and the honest way to compensate is
not to guess one — it is the operator's own Google Search Console, which is free
and authoritative for their own property: real queries, clicks, impressions, CTR
and average position. Three rules make those numbers usable rather than
misleading, and all three are asserted in `scripts/verify-search-console.mjs`:

* **Aggregates are the quantities Google reports.** CTR comes from the totals
  (clicks ÷ impressions), never the mean of the rows' CTRs; an average position is
  **impression-weighted**, or a site ranking #1 for a term nobody searches makes a
  #40 term look average.
* **"Low CTR" is judged against the site's own median at that position**, and a
  band needs enough of its own rows before it is used at all. A generic
  CTR-by-position table is fabricated precision the operator cannot check.
* **An empty window returns empty lists and a null CTR, not zeros** — "no data"
  and "nobody clicked" must not look the same.

**There is no backlinks method in the API.** Google's reference lists Search
Analytics, Sitemaps, Sites and URL Inspection — so "who links to you" cannot be
answered from here. The panel says that plainly and deep-links to Search
Console's own Links report; it must never imply a figure it cannot fetch. Real
backlink data in-product needs a paid index, which is a commercial decision, not
an API one.

## Structured data: a node you cannot source is a node you must not emit
Morpheus emits the page node (Article / Product+Offer / WebPage) and the **site
entity** — `Organization` plus `WebSite` with its `SearchAction` — on every page,
because those describe the site rather than the page and nothing else emits them
once we own the head. Every field traces to a real setting: the name and URL are
WordPress's own, a logo is emitted only when a Site Icon (or custom logo) exists,
and `sameAs` is omitted entirely because no configured profile source exists yet.
There is no invented rating, review count, price or `priceRange`.

**Never emit a partial entity.** A `LocalBusiness`/`Store` node is only worth
having with an address, a phone and opening hours — and WooCommerce's store
options hold an address and nothing else, so Morpheus does not emit one at all
(`verify-seo.mjs` §8 asserts the absence, and `tests/harness-noyoast.php` asserts
it on the rendered head). Adding one later needs new settings for phone/hours/geo
and must be **opt-in and off by default**.

**Check who else emits it before adding an entity.** A theme or another plugin may
already provide the store node — Woodmart does on valiantmusic.com.au, complete
with `Review`/`AggregateRating` and a `#business` `@id` — and two nodes describing
one business is the duplicate-entity version of the duplicate-title problem above.
Detect it by asking the operator and offering a setting, **not** by sniffing the
rendered head at runtime: that is fragile, and it fails silently the day the other
side changes its markup.

**Where these are checked.** `verify-seo.mjs` §8 asserts the source (CI, no PHP);
`tests/harness-noyoast.php` asserts the rendered `<head>` in a real WordPress via
Playground, including that every JSON-LD block parses. The two are deliberately
coupled by a check, so the rendered assertions cannot be deleted while the source
guard still passes.

## Advertise a sitemap that exists
When a site stops using an SEO plugin, everything advertising that plugin's
sitemap URL breaks at once — robots.txt (often cached for a month by a caching
plugin), Search Console submissions, third-party links — while core's own
`/wp-sitemap.xml` keeps answering 200 and goes unadvertised. Seen live: a 404
`/sitemap_index.xml` line sitting in a month-cached robots.txt.

`filter_robots_txt()` therefore judges a `Sitemap:` line before deferring to it,
and judges by **attribution, never by fetching** — robots.txt is served on every
crawl, so a lookup there is a performance trap:

- **dead** = our own host AND a conventional path belonging to a plugin this class
  can identify (`/sitemap_index.xml` → Yoast/Rank Math, `/sitemap.xml` → AIOSEO,
  `/sitemaps.xml` → SEOPress) AND that plugin is not the active one;
- **anything else** — another host, an unknown path, somebody else's sitemap index
  — is left exactly as it is. We are not the arbiter of other people's sitemaps,
  and the worst case must only ever be *adding* a line, never removing a working one;
- the filter does not run at all while another SEO plugin is active (`bootstrap()`),
  and the legacy-path rewrite is gated on the same condition.

The old path is then **served**, not left 404ing: `/sitemap_index.xml` 301s to
`/wp-sitemap.xml`, registered on `init` and flushed on activation — the same shape
as the TRAFFIC key-file rewrite. Rendered assertions live in
`tests/harness-noyoast.php` (dead line dropped, live line kept, another host
untouched, exactly one rewrite rule) and the source contracts in `verify-seo.mjs` §9.

## A canonical tag can be emitted twice, and did
While Morpheus owns the head it emits `<link rel="canonical">` at `wp_head`
priority 1, and WordPress core's `rel_canonical()` still fires at priority 10 —
so a singular view can render the tag twice, and the live homepage did. Fixing it
means deciding who owns canonical (removing core's is a shared-ownership decision,
like the head itself), so it belongs with the head-handover work and is recorded
here rather than patched blind.

## What is still missing here
A redirects manager (404 → target) is the one standard SEO capability absent. It
matters once a site has traffic; nothing else in the module depends on it.
