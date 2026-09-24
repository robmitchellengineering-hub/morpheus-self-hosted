// Do a change's required gates actually verify it? These assertions exist
// because the combined check state answers a different question — "did anything
// fail?" — and a PR can be full of green Netlify previews with no CI run at all.
// If these ever pass vacuously, an unverified change can reach production.
import { requiredGateVerdict, requiredGateMessage, SELF_DEV_REQUIRED_CHECKS } from './requiredChecks.js';
import assert from 'node:assert';

// The shape produced by getPullRequestChecks() from the real #258/#259 failure:
// a deploy preview plus Netlify's rule checks, one of them skipped, and NOT ONE
// check from the CI workflow. Every entry is green-ish, so `state` was 'passing'.
const INCIDENT = [
  { name: 'Header rules - morpheus-self-hosted-app', status: 'completed', conclusion: 'skipped' },
  { name: 'Pages changed - morpheus-self-hosted-app', status: 'completed', conclusion: 'skipped' },
  { name: 'Redirect rules - morpheus-self-hosted-app', status: 'completed', conclusion: 'success' },
  { name: 'netlify/morpheus-self-hosted-app/deploy-preview', status: 'completed', conclusion: 'success' },
];

// A repo with no known gates keeps the old behaviour — otherwise every tenant
// theme repo, which configures no CI, could never merge.
assert.deepStrictEqual(requiredGateVerdict(INCIDENT, []), { ok: true, required: [] });
assert.deepStrictEqual(requiredGateVerdict([], undefined), { ok: true, required: [] }, 'an absent list means no requirement');

// THE REGRESSION: green previews, no CI. This must never read as verified.
const incident = requiredGateVerdict(INCIDENT, SELF_DEV_REQUIRED_CHECKS);
assert.strictEqual(incident.ok, false, 'a green preview with no CI run is not a verified change');
assert.deepStrictEqual(incident.missing, SELF_DEV_REQUIRED_CHECKS, 'both gates are named as never having run');
assert.deepStrictEqual(incident.notSuccess, [], 'a gate that never ran is missing, not merely unsuccessful');

// The gates reporting success is the one shape that passes. The names are
// written out rather than spread from SELF_DEV_REQUIRED_CHECKS on purpose: this
// is the tripwire that fired when 'render' was promoted on 2026-09-24, which is
// exactly what a pinned expectation is for.
const green = requiredGateVerdict(
  [...INCIDENT, { name: 'guards (no install)', status: 'completed', conclusion: 'success' }, { name: 'lint + build', status: 'completed', conclusion: 'success' }, { name: 'render', status: 'completed', conclusion: 'success' }],
  SELF_DEV_REQUIRED_CHECKS,
);
assert.deepStrictEqual(green, { ok: true, required: SELF_DEV_REQUIRED_CHECKS });

// A gate that did not run verifies nothing. `skipped` is what a job with an
// `if:` that excluded it reports, and it is a conclusion the merge engine's OK
// list otherwise accepts for non-required checks.
//
// Every OTHER required gate is included and green, deliberately: without them
// the fixture would fail because a gate was *absent*, and the assertions below
// would pass even if the skipped-conclusion logic broke. (It did exactly that
// when 'render' was promoted and this fixture still listed only two gates.)
const ALL_OTHER_GATES_GREEN = [
  { name: 'guards (no install)', status: 'completed', conclusion: 'success' },
  { name: 'lint + build', status: 'completed', conclusion: 'success' },
  { name: 'render', status: 'completed', conclusion: 'success' },
];
const withGate = (name, override) => ALL_OTHER_GATES_GREEN
  .map((c) => (c.name === name ? { ...c, ...override } : c));

const skipped = requiredGateVerdict(withGate('lint + build', { conclusion: 'skipped' }), SELF_DEV_REQUIRED_CHECKS);
assert.strictEqual(skipped.ok, false, 'a skipped gate is not a passed gate');
assert.deepStrictEqual(skipped.missing, [], 'it ran — it just did not check anything');
assert.deepStrictEqual(skipped.notSuccess, [{ name: 'lint + build', conclusion: 'skipped', status: 'completed' }]);

// Same for neutral, and for a gate still running (the pure function is total:
// it must not pass a gate with no conclusion just because nothing failed).
assert.strictEqual(requiredGateVerdict(withGate('guards (no install)', { conclusion: 'neutral' }), SELF_DEV_REQUIRED_CHECKS).ok, false);
assert.strictEqual(requiredGateVerdict(withGate('render', { conclusion: null, status: 'in_progress' }), SELF_DEV_REQUIRED_CHECKS).ok, false);

// A required name is matched exactly, so a differently-named gate cannot satisfy
// it by accident (drift is caught by the ci.yml parity guard in verify-merge-gates).
assert.deepStrictEqual(requiredGateVerdict([{ name: 'Guards (no install)', conclusion: 'success' }], ['guards (no install)']).missing, ['guards (no install)']);
assert.strictEqual(requiredGateVerdict([{ name: '  lint + build  ', conclusion: 'success' }], ['lint + build']).ok, true, 'surrounding whitespace is trimmed, not significant');

// Junk in the payload must be ignored rather than crash the merge path.
assert.strictEqual(requiredGateVerdict([null, undefined, { conclusion: 'success' }, 'nope'], ['lint + build']).ok, false);

// The operator gets told what happened and what to do — not "checks took too
// long", which would misattribute a run GitHub never created.
const missingWords = requiredGateMessage(incident);
assert.ok(missingWords.includes('guards (no install)'), 'the gate is named');
assert.ok(missingWords.includes('lint + build'), 'every missing gate is named');
assert.ok(/Close the pull request and reopen it/.test(missingWords), 'the concrete fix is given');
assert.ok(/not merged/i.test(missingWords), 'the outcome is stated');
assert.ok(requiredGateMessage(skipped).includes('was skipped'), 'a skipped gate says so, in those words');
