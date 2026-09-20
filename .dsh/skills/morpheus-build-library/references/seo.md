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
page itself. Labelled per row (`people type this`, `competing page`, `this page`,
`AI idea`) because the weakest signal must not look like the strongest. Seeds come
from the page and the model only — scraping a competitor's headings as seeds fed a
form label to Google and dragged back "form name meaning in hindi".

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

## What is still missing here
A redirects manager (404 → target) is the one standard SEO capability absent. It
matters once a site has traffic; nothing else in the module depends on it.
