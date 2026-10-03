// Can a review run away with a build?
//
// WHY THIS EXISTS. Measured 2026-09-30 on a real backend generation: 37 AI calls, 473 credits, TWELVE of
// them reviewer calls at 9-17 credits each on the reasoning model — and nothing persisted. The review was
// the largest single cost of the run and it did not converge. `reviewAndRetry` re-reviewed EVERY file
// after each coder retry, so a 10-file backend cost 4 calls a pass and up to 3 passes, with no ceiling and
// no early exit.
//
// The rule now lives in `lib/reviewBudget.js` and is asserted here as BEHAVIOUR, because the failure mode
// is arithmetic and the arithmetic can be checked without a model, a key or a credit.
//
// The second half of this guard is the one that matters most: a review that stopped early must NOT be able
// to report itself as approval. "Not examined" is not "fine" — the rule `verificationCoverage.js` already
// enforces for the build gates, applied to the thing that spends the most money.
//
// Run:  node scripts/verify-review-budget.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REVIEW_BUDGET, createReviewBudget, canSpendReviewCall, spendReviewCall,
  canStartReReviewPass, startReReviewPass, reReviewScope, reviewOutcome, planReviewCalls,
} from '../server/src/lib/reviewBudget.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. the budget is a ceiling, and it is small on purpose');
// FIVE, not four. The first version set four and the first pass ate all of them, so the fix the review
// had just demanded was never re-checked — measured 2026-09-30. A budget that cannot afford to verify its
// own demand is worse than no budget, so one call is reserved.
check('five calls per operation, one of them reserved', REVIEW_BUDGET.maxCalls, 5);
check('…and one re-review pass', REVIEW_BUDGET.maxReReviewPasses, 1);

console.log('\n2. calls stop at the ceiling — the twelve-call run cannot recur');
const budget = createReviewBudget();
const spent = [];
for (let i = 0; i < 20; i++) {
  const allowed = canSpendReviewCall(budget);
  if (!allowed.ok) break;
  spendReviewCall(budget);
  spent.push(i);
}
check('exactly maxCalls calls were permitted', spent.length, REVIEW_BUDGET.maxCalls);
check('…and the ceiling is what stopped it', canSpendReviewCall(budget).ok, false);
check('…naming the budget in the reason', /budget of 5 call/.test(canSpendReviewCall(budget).reason || ''), true);
// The arithmetic from the real run: 10 files / 3 per chunk = 4 chunks, x 3 attempts = 12 calls.
check('a 10-file backend can no longer cost twelve reviewer calls',
  Math.min(Math.ceil(10 / 3) * 3, REVIEW_BUDGET.maxCalls), REVIEW_BUDGET.maxCalls);
// AND the budget has to be big enough to actually cover a realistic set in one pass, or the ceiling would
// be honest and useless: 4 calls covers 12 files at 3 per chunk, which is what a backend usually is.
check('the ceiling covers a 12-file set in one pass', Math.ceil(12 / 3) <= REVIEW_BUDGET.maxCalls, true);
check('…while still holding the re-review reserved', REVIEW_BUDGET.reserveForReReview, 1);

console.log('\n2b. the calls a pass will actually make are COUNTABLE, not greppable');
// The first version of this guard asserted that the budget check appeared before `invokeAI` in the source
// — and DELETING the check still passed, because the phrase survived elsewhere in the file. Counting what
// the planner returns cannot be fooled that way, and it is the number that costs money.
// FIVE chunks against a budget of FOUR, so there is a surplus to report. The first version used exactly
// four chunks (ten files) and then asserted a surplus — there was none, so the check failed while the code
// was right. A fixture that does not contain the condition proves nothing about it.
const tenFiles = [[{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }], [{ path: 'd.js' }, { path: 'e.js' }, { path: 'f.js' }], [{ path: 'g.js' }, { path: 'h.js' }, { path: 'i.js' }], [{ path: 'j.js' }, { path: 'k.js' }, { path: 'l.js' }], [{ path: 'm.js' }]];
const b0 = createReviewBudget();
// WITH THE RESERVE THE REVIEWER PASSES. Calling the planner without it measures a different function than
// the one that runs — the first version of this check did that and failed while the code was correct.
const planned = planReviewCalls(tenFiles, b0, { reserve: REVIEW_BUDGET.reserveForReReview });
check('a 13-file backend spends the unreserved allowance',
  planned.willReview.length, REVIEW_BUDGET.maxCalls - REVIEW_BUDGET.reserveForReReview);
check('…and the surplus chunk is reported unreviewed', planned.unreviewed, ['m.js']);
check('…with the budget marked spent', planned.stopped, true);
// The unreserved allowance is spent, but the RESERVED call survives — that is the reserve's whole point,
// and asserting "nothing at all is left" here would be asserting the bug it exists to prevent.
check('…leaving exactly the reserved call', canSpendReviewCall(b0).ok, true);
spendReviewCall(b0);
check('…and then nothing', canSpendReviewCall(b0).ok, false);
// The counter-check: a small change must not be starved by the ceiling. ONE call, one budget — the
// planner SPENDS, so calling it twice against the same budget measured the second call, not the first,
// and the first version of this check failed for that reason with the code correct.
const b1 = createReviewBudget();
const small = planReviewCalls([tenFiles[0]], b1);
check('a 3-file change still gets its one call', small.willReview.length, 1);
check('…and nothing is reported unreviewed', small.unreviewed, []);

console.log('\n3. re-review passes stop after one');
const b2 = createReviewBudget();
check('the first pass is allowed', canStartReReviewPass(b2).ok, true);
startReReviewPass(b2);
check('…and the second is not', canStartReReviewPass(b2).ok, false);
check('…naming the limit', /1 re-review pass/.test(canStartReReviewPass(b2).reason || ''), true);

console.log('\n4. a re-review covers only what the fix could have changed');
const paths = ['a.js', 'b.js', 'c.js', 'd.js'];
const scoped = reReviewScope([{ severity: 'critical', path: 'b.js', message: 'x' }], paths);
check('only the named file is re-examined', scoped.paths, ['b.js']);
check('…and it is marked narrowed', scoped.narrowed, true);
check('two issues in one file still give one path',
  reReviewScope([{ path: 'b.js' }, { path: 'b.js' }], paths).paths, ['b.js']);
check('two files gives two', reReviewScope([{ path: 'b.js' }, { path: 'd.js' }], paths).paths, ['b.js', 'd.js']);
// The fallback must widen, not guess: an issue that names no file has not told us what changed, and
// narrowing on a guess would skip a file that may be the broken one.
const unnamed = reReviewScope([{ severity: 'critical', message: 'something is wrong' }], paths);
check('an issue naming no file re-checks everything', unnamed.paths, paths);
check('…and says why, rather than looking narrowed', unnamed.narrowed, false);
check('…and an empty issue list also falls back to everything', reReviewScope([], paths).paths, paths);
check('a missing path list does not crash', reReviewScope([{ path: 'a.js' }], undefined).paths, ['a.js']);

console.log('\n5. a stopped review may NOT claim approval');
// The important one. Failing open here would turn "we ran out of money" into "it passed", which is the
// single most dangerous thing a cost control can do.
const partial = reviewOutcome({ reviewedPaths: ['a.js', 'b.js'], unreviewedPaths: ['c.js'], approved: true, budget });
check('it is marked partial', partial.partial, true);
check('…and approval is refused even though the reviewer said yes', partial.approved, false);
check('…naming what was never checked', partial.unreviewedPaths, ['c.js']);
check('…in a sentence an operator can read', /has not been checked/.test(partial.note || ''), true);
const complete = reviewOutcome({ reviewedPaths: ['a.js'], unreviewedPaths: [], approved: true });
check('a complete review keeps its verdict', complete.approved, true);
check('…and is not partial', complete.partial, false);
check('…and has no note to print', complete.note, null);
const nothing = reviewOutcome({ reviewedPaths: [], unreviewedPaths: ['a.js', 'b.js'] });
check('a review that examined NOTHING cannot approve', nothing.approved, false);

console.log('\n6. the reviewer actually uses it — a rule nobody calls changes nothing');
const rev = code(read('server/src/lib/reviewer.js'));
check('reviewFileOperations accepts a shared budget', /stageName = 'reviewer', budget = null/.test(rev), true);
// Against COMMENT-STRIPPED code. The first version of this ran on the raw source, and the explanatory
// comment between the check and the call pushed `invokeAI(` past the window — so a correct order read as
// a failure. Tenth time in this suite that prose has decided an assertion's outcome.
check('…checks the budget BEFORE making a call, not after',
  /canSpendReviewCall\(budget\)[\s\S]{0,400}?invokeAI\(/.test(code(read('server/src/lib/reviewer.js'))), true);
// `spendReviewCall` moved INTO the planner with that refactor, so grepping the reviewer for it now checks
// for a call that legitimately is not there. What matters is that the reviewer decides its calls through
// the counted planner — asserted by name, and by section 2b's arithmetic.
check('…and decides its calls through the counted planner', /planReviewCalls\(chunks, budget,/.test(rev), true);
check('…and carries unreviewed files out of the pass', /unreviewed: outcome\.unreviewedPaths/.test(rev), true);
check('the retry loop creates ONE budget for the whole operation', /const budget = createReviewBudget\(\)/.test(rev), true);
check('…bounded by both the pass limit and the call ceiling',
  /canStartReReviewPass\(budget\)/.test(rev) && /canSpendReviewCall\(budget\)/.test(rev), true);
check('…stopping loudly rather than silently', /stopping the fix\/re-review loop/.test(read('server/src/lib/reviewer.js')), true);
check('…and the re-review is scoped, not the whole set', /reReviewScope\(/.test(rev), true);
check('…naming how many files it re-examines', /re-reviewing \$\{scopedOps\.length\}/.test(read('server/src/lib/reviewer.js')), true);
check('the result reports partiality and the call count',
  /partial: Boolean\(review\.partial\)/.test(rev) && /reviewCalls: budget\.callsUsed/.test(rev), true);

console.log('\n7. the shared budget is genuinely shared');
// Two passes each with their own ceiling is how the ceiling stops meaning anything.
const shared = createReviewBudget();
for (let i = 0; i < REVIEW_BUDGET.maxCalls - 1; i++) spendReviewCall(shared);
check(`after ${REVIEW_BUDGET.maxCalls - 1} calls one is left`, canSpendReviewCall(shared).ok, true);
spendReviewCall(shared);
check(`…and the ${REVIEW_BUDGET.maxCalls + 1}th is refused`, canSpendReviewCall(shared).ok, false);
check('a missing budget does not block a caller that has none', canSpendReviewCall(null).ok, true);
check('…and spending against one is a no-op, not a crash', (() => { spendReviewCall(null); return true; })(), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a review could still spend without limit, or claim a pass it did not make\n');
  process.exit(1);
}
console.log('a review is bounded, re-examines only what changed, and cannot call itself approval\n');
