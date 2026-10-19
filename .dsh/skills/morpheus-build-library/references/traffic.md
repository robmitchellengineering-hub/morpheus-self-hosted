# Traffic — getting pages indexed, and proving it

Read this before touching the TRAFFIC tab, the IndexNow submission, or anything
that claims traffic work. The plan it comes from is `morpheus-traffic-tab-plan.md`
in the DSH workspace; the build state is whatever `scripts/context.mjs` and
`scripts/reality.mjs` say, never this card.

## The rule this feature exists to keep

**A submission is not an index.** IndexNow returns an HTTP status and nothing
else — it does not tell us a URL was crawled, indexed, ranked, or seen by anyone.
So the tab says *submitted* or *accepted*, never *indexed*, and every claim it
makes has to be sourceable to a ledger row.

Two statuses that look alike and are not:

| Code | Means |
|---|---|
| 200 | the URL was submitted successfully |
| 202 | the URL was **received — key validation pending** |
| 403 | the key file was not found at its location |
| 422 | the URLs did not belong to the host |

Collapsing 200 and 202 hides the one state an operator needs: a site whose key
file is not being served gets 202s, and that is the difference between "working"
and "will never work". `verify-traffic.mjs` asserts both notes exist.

## Evidence, or it did not happen

Every submission writes a ledger row: UTC time, URL, action, the real HTTP status
and a short note. Bounded (oldest rows fall off) because it is written on every
publish for the life of a site. The ledger is the reason the tab is allowed to say
anything at all — a traffic feature with no record is faith, and this repo does not
ship faith.

Corollary: **"last accepted" is the only success signal we may show.** Not a rate,
not a trend, not "traffic driven". Nothing else here is measured.

## Where each half belongs

- **Submission on publish belongs in the plugin.** It sees the status transition,
  so it works with Morpheus closed, and IndexNow needs no OAuth — just a key file
  the site serves. The submission is *scheduled*, not sent during the save: an
  operator's publish must never wait on a third party, and a failure must never
  appear as an error on their site.
- **Backfill, sitemap hygiene and orphan detection belong in the app**, which is
  where the Search Console data lives.
- **The ledger lives in the plugin's own state** beside the deploy log —
  deliberately not a new app table. Hand-run SQL migrations are a known hazard
  here and this feature does not justify one.

## Buttons that are safe to press twice

Backfill skips any URL already accepted, so a second press does nothing rather
than re-submitting a whole site to a free service. It is also bounded per run.
Caps exist on both sides of the boundary and `verify-traffic.mjs` asserts they
agree — a cap that only exists in one file is a cap that will drift.

## One component, both surfaces

The tab is mounted by the app's WEBSITE panel **and** the dock, and
`verify-context.mjs` §11 fails if the dock forks a `*Tab`. Its widget-token scope
lists **exactly** the functions the tab invokes (`trafficAction`), asserted by
`verify-traffic.mjs` against the tab's own source. A scope entry nothing invokes is
privilege handed out for free; a scope missing one the tab calls is a 403 at the
last click.

## Deliberate, not accidental

- **The feature is off until the operator turns it on.** Submitting URLs is an
  outward action on their live site.
- **The key rule is ours, not the spec's.** IndexNow allows `[A-Za-z0-9-]` of 8–128
  characters and its own example key is not hex; we generate and serve 32 hex, and
  the app validates the same shape. Widening one side alone accepts a key the site
  cannot serve — that is a two-file change, never a regex tweak.
- **Nothing claims a plan item is built when it is not.** The tab lists sitemap
  hygiene, orphan/internal links, service pages and Google Business Profile as not
  built, and the plugin sends that list so the UI cannot invent it. GBP is gated by
  Google: a verified profile active 60+ days, then an access request they review.
