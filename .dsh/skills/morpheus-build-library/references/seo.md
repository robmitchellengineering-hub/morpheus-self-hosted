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

## What is still missing here
A redirects manager (404 → target) is the one standard SEO capability absent. It
matters once a site has traffic; nothing else in the module depends on it.
