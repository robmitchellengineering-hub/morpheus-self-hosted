# Verification: making a check that can actually fail

## The bar
"It builds" is not verification. `npm run lint && npm run build` proves the syntax
and the bundler, nothing else. `node scripts/verify.mjs` is the one command that
boots the real server, resolves every relative import and runs every pure guard —
run it before every merge. Frontend work needs a real browser; backend work needs
the real function against real input.

## A guard that cannot fail is worse than no guard
The failure mode to watch for, hit three times in one session: **asserting that a
string exists instead of that the invariant holds.**

* `check('skipped files are reported', has(php, "'skipped'"), true)` — passes even
  when the response no longer includes the list, because the key is still built
  somewhere. Assert the *value*: `has(php, "'skipped'   => array_slice( $skipped")`.
* `check('timeouts exist', (src.match(/FETCH_TIMEOUT_MS/g) || []).length >= 2)` —
  still passed after one of two timeouts was deleted, because the constant
  declaration supplied the count. Count them against each other:
  timeouts >= number of `await fetch(` calls.
* A regex that matched the prose "HMAC-SHA2" instead of the element that renders
  the pairing code. Tie assertions to the element: `id="morpheus-pair-code"`.
* An ordering assertion whose first match was a docblock sentence mentioning the
  function. Slice the function body first, then look inside it.
* Comments that *document* a rule ("deliberately no volumes here") must not trip
  the check that enforces it. Strip comments before text assertions.

## Mutation-test every new guard
Paste the guard into a temp dir with copies of the files it reads, mutate one
thing, and confirm it fails. A guard shipped without this is unverified. Real
catches from that process: swapping `hash_equals` for `===`, deleting a rate
limit, letting a failed fetch throw instead of returning, dropping provenance
from a row, rendering an invented metric in the UI.

## Harness fidelity
A stub is only a test if it behaves like the thing it replaces.
`pre_http_request` short-circuits the transport, so WordPress's streaming
download never writes the temp file — the "downloaded" file stays empty and the
hash can never match. The stub has to write to `$args['filename']` itself.

Load the environment the real code runs in. Rendering an admin screen from a CLI
context died on `submit_button()` until `wp-admin/includes/template.php` was
required — that read as a product failure and was a harness gap.

A test that reaches a live third party is not a test. The update-channel harness
supplies the manifest as a fixture through the plugin's own filter seam, because
otherwise it verifies against the wrong package and passes or fails on the
weather.

## Shell traps that produce silent, misleading failures
`set -euo pipefail` plus `| head -1` inside a command substitution turns "grep
matched nothing" (or `head` exiting first and SIGPIPE-ing the grep) into an abort
with **no output at all** — which reads as a plugin failure. Add `|| true`, take
the first line outside the substitution.

`pkill -f <pattern>` kills your own background job when it matches the same
pattern. Check `job_list` before reaching for it.

## Evidence over inference
Query the thing. "The column is missing" is a hypothesis until
`verify-schema-prod.mjs` or a real query says so; "the deploy worked" is a
hypothesis until the health endpoint answers. Four separate false alarms in one
session came from reading code and assuming its runtime consequence.

## Six more ways a check lies to you

* **A guard is only pure if it is pure *transitively*.** A guard that imported
  `splitOvershoot` from `billing.js` resolved every relative import perfectly and
  still killed CI's no-install guards job, because `billing.js` reaches
  `@prisma/client` through `db.js` — and `server/package-lock.json` is untracked
  (H4), so CI cannot install. Extract the pure half into a dependency-free
  module; that is exactly why `lib/billingClamp.js` exists.
  `verify-guards-no-install.mjs` walks the guards job's own scripts and fails on
  any reachable package import.
* **A red check is a stop, not a formality.** One PR was merged with the guards
  job red because it passed locally, where `node_modules` was present. The local
  pass was the anomaly, not the CI failure.
* **Audit the list, not just the members.** Every individual claim in `AGENTS.md`
  was true while its *table* said "Three project skills" and there were nine, and
  stopped at H10 when twelve hazards existed. A short list that reads as complete
  is worse than no list, because nothing prompts you to look further — so the
  count and the membership are asserted in `verify-context.mjs`.
* **Test both branches of a third-party conditional.** The SEO duplicate-tag rule
  has two halves, so the plugin harness boots WordPress **twice** — once with
  Yoast, once without — because the no-plugin half was never testable in one boot.
* **A safety check must fail *open* on the path you cannot test.** The H9 drift
  guard had to be built so that an unrecognised error shape does not refuse every
  push: "one unrecognised shape there and the H9 guard becomes the reason self-dev
  cannot push at all — a safety check turned into an outage."
* **Assert the mechanism is on the live path.** A retry loop that only retried on
  HTTP 404 never fired for the 422 failure that actually happened; later it was
  found "wired to dead code, never fired". The code existed, was correct, and ran
  never.

## Removing behaviour passes every gate

H1 covers a shared module losing an **export**. The quieter and worse case is a
module that keeps its shape and loses its *behaviour*: `server/src/ai.js` was
rewritten from 585 lines to 153 in a self-dev push — dropping `fetchWithTimeout`,
model auto-discovery, the platform temperature override, `reserveCredits` /
`reconcileCredits`, the provider-balance fallback and truncation handling — while
`node --check`, lint and build all stayed green, because none of them read
behaviour. It was reverted twice and the reason was never written down.

**Rule:** when a shared module changes, diff what it *does*, not only what it
exports. A deleted `// WHY` comment is the cheapest signal that a behaviour left
with it.

## Assert the property, not the configuration

`verify-cors.mjs` does not check a list of allowed origins — it asserts the thing
that actually matters: **no input can produce `Access-Control-Allow-Origin: *`
together with `Allow-Credentials: true`.** A list is a snapshot of a decision
someone made; the property is the decision. The same shape works for any security
rule: name the forbidden combination, then try to produce it.

Build the test out of the *inputs that matter*, too. The billing clamp's guard is a
41,205-case sweep rather than a handful of examples, because the bug it catches
lived in the combinations nobody thought to try.

