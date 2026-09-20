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
