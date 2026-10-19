# AI-backed features: the model is untrusted input

## Give the response shape no room for an invention
When a feature must not claim something it cannot know, the strongest rule is a
shape with nowhere to put it. Keyword research has **no field** for a search
volume, difficulty score, CPC or ranking, and
`scripts/verify-keywords.mjs` asserts that absence at every depth of the payload
plus that the UI renders no metric. A prompt that says "do not invent volumes" is
a request; a shape with no volume field is a guarantee.

The same idea, applied elsewhere: SEO suggestions carry the id they came from and
are dropped unless it is an id we asked about; internal-link anchors must appear
verbatim in the page's own text; a hallucinated URL is dropped and *reported with
its reason* rather than silently hidden.

## Ground from the system, never from the caller
Titles, page text and permalinks come from the site, not from the widget. A
caller sends ids; the server fetches the content. Otherwise a fabricated title
writes metadata onto someone else's page.

## Prove the thing you are about to claim
"An anchor must exist in the text" is enforced twice — once in the normaliser and
once in the plugin, where the phrase must sit in a text node. The second gate
caught a phrase spanning two HTML blocks that validated in flat text. Layered
checks are not redundancy when the layers see different things.

## Billing and cost
`invokeAI` needs a real `userId`. Passing `undefined` silently skips the
pre-call reservation and the meter — a cost leak that is invisible in testing
because everything still works. Every caller passes the acting user.

## Prompt hygiene
* Blank lines between sections are deliberate; a `filter(Boolean)` over a line
  array silently deletes them and every prompt becomes a wall of text.
* State the limits as numbers, and ask for the tokens you mean: `%title%`-style
  substitution, 60-character titles, 2–6 word anchors.
* Say what must never happen ("never invent a fact … a plausible-sounding
  fabrication is the worst outcome here") and then *enforce* it in code.
* Prompt version drift is real: the guard asserts the sections are still
  separated, because a prompt that quietly loses structure degrades output
  without failing anything.

## Where the data honestly comes from
Free and real: Google autocomplete (what people type), a competitor page's own
title/description/headings, the page itself. Paid and therefore absent:
volumes, difficulty, competitor rankings and competitor backlinks. Google Search
Console is the free authoritative source for *your own* queries, positions, CTR
and backlinks — OAuth, property verified.

## Three ways a model call fails while looking like it succeeded

* **A truncated call reads as a negative answer.** The deployed model spends real
  budget on hidden reasoning *before* any visible text, so a small `maxTokens`
  returns `200` with an empty or short body — and a classification of
  `isInquiry: false` looks exactly like a confident "not an inquiry". Ask for the
  tokens you mean against the model that is actually deployed, and treat
  `OUTPUT_TRUNCATED` as a failure rather than a result.
* **Never mark work done before the work succeeded.** The Gmail flow marked a
  message as seen regardless of whether its classification ran, so a transient
  failure excluded that message from ever being reclassified — permanently.
* **An external query can succeed and return nothing, forever.** A Gmail filter
  of `category:primary` returned **zero messages, ever, with no date bound**; the
  sync reported success on every run since the feature shipped and dropped every
  real inquiry that came in. Prove a query returns non-empty against a
  known-populated account *before* building a feature that depends on it. H10
  covers a 404; this is the quieter failure — a 200 with an empty set.
* **A partially-read list must never be treated as the whole list.** Fetching the
  newest N and calling that "everything" meant a message outside the window was
  never looked at, while the run reported a clean pass — and the fix was to
  paginate until it reached mail already processed, not to widen N. If a worker
  drains a queue, its stopping condition belongs to the queue, not to a number
  someone picked.

## Billing: the true-up must have a floor

`reconcileCredits` added the post-call difference unconditionally, so a call
whose real cost exceeded its reservation could take an account below zero —
production had one at **−3.7712 credits**, which makes the product's "hard stop
before overspend" claim false. The fix takes only what the account actually
holds and absorbs the remainder as platform cost, logged rather than swallowed.
`verify-billing-clamp.mjs` asserts the invariant with a 41,205-case sweep.

