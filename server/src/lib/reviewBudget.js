// How much work a review is allowed to do, and what it re-reviews.
//
// WHY THIS EXISTS. Measured 2026-09-30 on a real backend generation: the run made **37 AI calls and burned
// 473 credits, twelve of them reviewer calls at 9–17 credits each on the reasoning model — and persisted
// nothing.** The review was the largest single cost and it did not converge.
//
// Two structural reasons, both visible in `reviewer.js`:
//
//   1. NOTHING BOUNDS IT. `reviewFileOperations` chunks the files 3 at a time (so a 10-file backend is 4
//      calls per pass) and `reviewAndRetry` re-reviews EVERYTHING after each coder retry, up to
//      MAX_REVIEW_ATTEMPTS (3). That is 4 x 3 = 12 reviewer calls for one generation, with no ceiling and
//      no early exit. If the retry does not satisfy the reviewer — and with a schema-shaped `approved`
//      flag, non-convergence is the expected case, not the unlucky one — the same total is spent again on
//      the next turn.
//
//   2. IT RE-REVIEWS FILES NOTHING CHANGED. The retry prompt asks for full corrected content of the
//      files that need changes ("Only re-output files that need changes"), but the re-review then runs
//      over the whole set again. Files that were already approved, and files the fix never touched, are
//      re-examined at full price. Nothing about a re-review of unchanged files can change their verdict,
//      so that spend buys nothing at all.
//
// This module is the decision, extracted as pure functions so a guard can assert the bounds without a
// model. The reviewer keeps its judgement; this decides how much of it the run can afford and what it is
// spent on.
//
// WHAT IT MUST NOT DO: turn "we ran out of budget" into "approved". A review that stopped early examined
// part of the change, and that is reported as exactly that. The repo already bans the other direction for
// coverage gates — "a pass from a check that examined nothing is not a pass" — and a review is the same
// kind of claim.

/**
 * The ceiling on reviews for ONE code-producing operation.
 *
 * `maxCalls` is per operation, not per turn: a backend generation is one operation, a chat build is
 * another. `firstPassFiles` documents the shape rather than being enforced here — the caller chunks.
 *
 * The numbers are deliberately small. A review is a second opinion; ten of them is not ten times the
 * confidence, it is the same opinion paid for repeatedly. Four calls covers a 9-12 file backend in one
 * pass with one re-review of what changed.
 */
export const REVIEW_BUDGET = Object.freeze({
  maxCalls: 5,
  maxReReviewPasses: 1,
  // Calls held back from the FIRST pass so there is something left to re-check the fix with. Without it
  // the first pass consumes the whole ceiling and the re-review is silently skipped — measured 2026-09-30:
  // four chunks spent all four calls, and the fix that the review had just demanded was never checked.
  // A budget that cannot afford to verify its own demand is worse than no budget.
  reserveForReReview: 1,
});

/**
 * Which files a re-review should cover.
 *
 * Only the files named by CRITICAL issues, because only those can have changed: the retry prompt asks the
 * coder to re-output the files with issues and nothing else, so every other file's content is byte-for-
 * byte what the previous review already saw. Re-reviewing those cannot change their verdict — it can only
 * cost the same money again.
 *
 * Falls back to the whole set when the issues name no usable path: a review that reports a problem without
 * naming where it is has not told us what changed, and guessing narrowly would hide a real problem.
 */
export function reReviewScope(criticalIssues, allPaths) {
  const named = [...new Set(
    (Array.isArray(criticalIssues) ? criticalIssues : [])
      .map((i) => (typeof i?.path === 'string' ? i.path.trim() : ''))
      .filter(Boolean),
  )];
  if (named.length > 0) return { paths: named, narrowed: true, reason: 'only the files a critical issue named' };
  return { paths: [...(Array.isArray(allPaths) ? allPaths : [])], narrowed: false, reason: 'the issues named no file, so the whole set is re-checked rather than guessing narrowly' };
}

/**
 * A running budget for one operation. Create it once per `reviewAndRetry` call and pass it down, so the
 * per-pass chunking and the retry loop share one ceiling rather than each having its own.
 */
export function createReviewBudget({ maxCalls = REVIEW_BUDGET.maxCalls, maxReReviewPasses = REVIEW_BUDGET.maxReReviewPasses } = {}) {
  return { callsUsed: 0, maxCalls, reReviewPasses: 0, maxReReviewPasses, stopped: null };
}

/**
 * How many calls a pass may use, given whether a re-review still has to be paid for.
 *
 * The reserve is only taken on the FIRST pass. A re-review is the last thing that happens, so reserving
 * against one would strand a call forever and the ceiling would be a lie.
 */
export function passCallAllowance(budget, { reserve = 0 } = {}) {
  if (!budget) return Infinity;
  return Math.max(0, budget.maxCalls - budget.callsUsed - reserve);
}

/**
 * Decide, UP FRONT, which review calls a pass will actually make.
 *
 * This is the bound as a pure function, so it can be asserted by counting rather than by grepping for a
 * guard clause. The first version of the guard checked that `canSpendReviewCall` appeared before
 * `invokeAI` in the source — and deleting the check entirely still passed, because the phrase survived
 * elsewhere in the file. Counting what the planner returns cannot be fooled that way.
 *
 * Returns the chunks to review, the files that will go unreviewed, and whether the budget stopped it.
 */
export function planReviewCalls(chunks, budget, { reserve = 0 } = {}) {
  const willReview = [];
  const unreviewed = [];
  let allowance = passCallAllowance(budget, { reserve });
  for (const chunk of chunks || []) {
    if (allowance <= 0 || !canSpendReviewCall(budget).ok) {
      unreviewed.push(...(chunk || []).map((op) => op?.path).filter(Boolean));
      continue;
    }
    spendReviewCall(budget);
    allowance -= 1;
    willReview.push(chunk);
  }
  return { willReview, unreviewed, stopped: allowance <= 0 || Boolean(budget?.stopped), reservedForReReview: reserve };
}

/** May another review call be made? Returns `{ ok }` or `{ ok: false, reason }`. */
export function canSpendReviewCall(budget) {
  if (!budget) return { ok: true };
  if (budget.stopped) return { ok: false, reason: budget.stopped };
  if (budget.callsUsed >= budget.maxCalls) {
    budget.stopped = `the review budget of ${budget.maxCalls} call(s) for this operation is spent`;
    return { ok: false, reason: budget.stopped };
  }
  return { ok: true };
}

/** Record one review call. */
export function spendReviewCall(budget) {
  if (budget) budget.callsUsed += 1;
}

/** May another fix-and-re-review pass start? */
export function canStartReReviewPass(budget) {
  if (!budget) return { ok: true };
  if (budget.reReviewPasses >= budget.maxReReviewPasses) {
    budget.stopped = budget.stopped || `the review allows ${budget.maxReReviewPasses} re-review pass(es) per operation`;
    return { ok: false, reason: budget.stopped };
  }
  return { ok: true };
}

/** Record one fix-and-re-review pass. */
export function startReReviewPass(budget) {
  if (budget) budget.reReviewPasses += 1;
}

/**
 * What a review that stopped early may and may not claim.
 *
 * `partial` is the whole point: the caller must be able to tell the operator that part of the change was
 * reviewed and part was not. `approved` is forced false when anything went unreviewed, because "not
 * examined" is not "fine" — the same rule `verificationCoverage.js` enforces for the build gates.
 */
export function reviewOutcome({ reviewedPaths = [], unreviewedPaths = [], approved = false, budget = null }) {
  const unreviewed = [...new Set(unreviewedPaths)];
  const partial = unreviewed.length > 0;
  return {
    partial,
    approved: partial ? false : Boolean(approved),
    reviewedPaths: [...new Set(reviewedPaths)],
    unreviewedPaths: unreviewed,
    stoppedBecause: budget?.stopped || null,
    note: partial
      ? `Reviewed ${reviewedPaths.length} of ${reviewedPaths.length + unreviewed.length} file(s); the review stopped before ${unreviewed.join(', ')}${budget?.stopped ? ` — ${budget.stopped}` : ''}. Anything not listed as reviewed has not been checked.`
      : null,
  };
}
