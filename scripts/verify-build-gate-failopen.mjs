// Can a failed AI gate cost the user their whole build?
//
// WHY THIS EXISTS. The build turn runs the coder, then a REVIEW, then applies the result. The review
// is advisory — a second opinion about code that already exists — but `reviewFileOperations` awaits
// `invokeAI` with no catch and `reviewAndRetry` has none either, so a reviewer throw propagated to the
// outer handler with `appliedOps` still empty. The entire turn went in the bin: the plan, every chunk
// the coder had produced, and the reply. `applyFileOperations` does not run until ~300 lines later.
//
// That is not hypothetical. `invokeAI` throws on a provider 5xx past undici's header timeout, on
// OUTPUT_TRUNCATED, and on InsufficientCreditsError — so the failure needs no bug at all, only a slow
// reviewer, and the more of the user's budget the build has already spent the more expensive it is.
//
// The rule now lives in `lib/reviewFailOpen.js` and is asserted here as BEHAVIOUR, not shape: a
// reviewer that throws must still leave the coder's operations intact and must be reported as not
// having run. The sibling defects in this same class are pinned structurally below, because each is an
// ordering fact about a 2,300-line function rather than a function anyone can call.
//
// Run:  node scripts/verify-build-gate-failopen.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReviewerFailOpen, reviewFailureNote } from '../server/src/lib/reviewFailOpen.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'server/src/functions/chatWithMorpheus.js';
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const raw = read(FILE);
// Comments out before structural assertions: this file explains the bug it fixes in prose, and an
// assertion matching its own explanation has already fooled six checks in this session's guards.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const OPS = [{ path: 'src/a.js', action: 'create', content: 'export const a = 1;' }];
const REVIEWED_OPS = [{ path: 'src/a.js', action: 'update', content: 'export const a = 2;' }];

console.log('\n1. a reviewer that throws does not take the coder\'s work with it');
const boom = await runReviewerFailOpen({ fileOps: OPS, run: async () => { throw new Error('undici header timeout'); } });
check('the coder\'s operations survive', boom.fileOps, OPS);
check('…and are the SAME array, not an empty replacement', boom.fileOps.length, 1);
check('the reviewer result is null, not a fabricated one', boom.reviewed, null);
check('the reason is carried out, not swallowed', boom.failed, 'undici header timeout');

console.log('\n2. …and the failure can never read as a pass');
// The whole risk of failing open is that it becomes failing quietly. Anything the caller could read as
// "reviewed and fine" has to be absent or explicitly false.
check('no approved flag is invented', 'approved' in (boom.reviewed || {}), false);
check('no summary is invented', 'reviewSummary' in (boom.reviewed || {}), false);
check('no issue list is invented', 'issues' in (boom.reviewed || {}), false);
check('the failure is reported as a non-empty string', typeof boom.failed === 'string' && boom.failed.length > 0, true);
check('…and it says which failure, not just "error"', boom.failed.includes('timeout'), true);

console.log('\n3. a reviewer that succeeds is returned untouched');
const good = await runReviewerFailOpen({
  fileOps: OPS,
  run: async () => ({ fileOps: REVIEWED_OPS, attempts: 2, approved: true, reviewSummary: 'ok', issues: [], reviewerModel: 'm' }),
});
check('the reviewer\'s operations win', good.fileOps, REVIEWED_OPS);
check('…including its retry count', good.reviewed.attempts, 2);
check('…and its verdict is passed through', good.reviewed.approved, true);
check('…and nothing is reported as failed', good.failed, null);
// This wrapper must add no policy: if it "improved" a successful review it would be a second,
// invisible reviewer whose behaviour nothing else in the repo knows about.
check('the successful result is the same object the reviewer returned',
  good.reviewed.reviewSummary, 'ok');

console.log('\n4. a reviewer that returns nothing usable counts as not having run');
// The second door to the same loss: a resolved-but-empty result would be read downstream as
// `fileOps = undefined`. A throw is not the only way to lose the work.
for (const [what, value] of [['undefined', undefined], ['null', null], ['an object with no fileOps', { attempts: 0 }], ['fileOps as a string', { fileOps: 'src/a.js' }]]) {
  const r = await runReviewerFailOpen({ fileOps: OPS, run: async () => value });
  check(`a reviewer resolving ${what} keeps the coder's work`, r.fileOps, OPS);
  check(`…and reports that it did not run`, typeof r.failed === 'string' && r.failed.length > 0, true);
}
check('an empty operation list is still preserved as an empty list, not treated as failure alone',
  (await runReviewerFailOpen({ fileOps: [], run: async () => ({ fileOps: [] }) })).fileOps.length, 0);
check('no fileOps argument at all does not crash', (await runReviewerFailOpen({ run: async () => { throw new Error('x'); } })).fileOps, []);

console.log('\n5. the user is told, in words that cannot be misread');
const note = reviewFailureNote('undici header timeout');
check('the note says the change WAS applied', /were still applied/.test(note), true);
check('…and that the check did NOT happen', /could not run/.test(note), true);
check('…and does not claim the reviewer found nothing', /found nothing|no issues/i.test(note), false);
check('…and names the reason', note.includes('undici header timeout'), true);
check('…and offers the recovery', /re-check/.test(note), true);
check('no failure means no note at all — the normal path is silent', reviewFailureNote(null), null);
check('an empty failure is also no note', reviewFailureNote(''), null);

console.log('\n6. the route actually uses the rule, rather than inlining a second copy');
check('the review call goes through runReviewerFailOpen', /await runReviewerFailOpen\(\{/.test(src), true);
check('…and the reply note comes from the module', /reviewFailureNote\(reviewerFailed\)/.test(src), true);
// A bare try/catch around the reviewer would pass the behavioural checks above while leaving the real
// call site unprotected, which is exactly the mistake this guard exists to catch.
check('…and it is NOT also wrapped in a hand-rolled try/catch',
  /try \{\s*reviewResult = await reviewAndRetry|try \{\s*const reviewed = await reviewAndRetry/.test(src), false);
check('the fileOps handed on are the wrapper\'s, not the reviewer\'s directly',
  /fileOps = review\.fileOps;/.test(src), true);

console.log('\n7. the ordering that made it fatal — the apply comes long after the review');
// Asserted as an ORDER, not a presence: if `applyFileOperations` ever moved above the review, the whole
// class disappears and this guard should be simplified rather than left asserting a stale hazard.
const iApply = src.indexOf('appliedOps = await applyFileOperations(');
const iReview = src.indexOf('await runReviewerFailOpen({');
check('the apply happens after the review', iApply > iReview, true);
check('…by a long way, which is why a throw there was so expensive', (iApply - iReview) / 1000 > 5, true);

console.log('\n8. the same class in the self-dev deep verify (fail-closed, still not a throw)');
const iDeep = src.indexOf('deep = await adapter.verify({');
const iDeepTry = src.indexOf('try {\n          deep = await adapter.verify({');
check('the first deep verify is guarded', iDeepTry > 0, true);
check('…and `deep` is never defaulted to a pass', /deep\s*=\s*\{\s*ok:\s*true/.test(src), false);
check('an unverifiable run is recorded as critical, so the refusal survives',
  /deepVerifyCritical = \[`the self-dev verification could not run at all/.test(raw), true);
check('…and the critical list still blocks a self-dev step from advancing',
  /buildProgressed = appliedOps\.length > 0 && unresolved\.length === 0 && syntaxCritical\.length === 0 && deepVerifyCritical\.length === 0/.test(src), true);

console.log('\n9. the failure is visible in the record, not only in the reply');
check('rework carries the reviewer failure count', (src.match(/reviewerFailed: reviewerFailed \? 1 : 0/g) || []).length, 3);
check('the usage row reports false for reviewed when there was none',
  /reviewed: !!reviewerModel/.test(src), true);
check('…and reviewerModel is only set when the reviewer ran',
  src.indexOf('reviewerModel = review.reviewed.reviewerModel') > src.indexOf('if (review.reviewed) {'), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a failed advisory check could still throw away a build the user already paid for\n');
  process.exit(1);
}
console.log('a review that cannot run applies the work, says so, and cannot read as a pass\n');
