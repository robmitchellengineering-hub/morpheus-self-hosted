// A review that could not run must not cost the user the build.
//
// WHY THIS IS A MODULE AND NOT AN INLINE try/catch. `reviewAndRetry` awaits the reviewer with no
// catch, and until this existed the call site was unwrapped too — so one failed REVIEW call reached
// the outer handler with `appliedOps` still empty and discarded the whole turn: the plan, every chunk
// already generated, and the reply. The review is a second opinion about code that already exists;
// losing the code because the opinion could not be formed inverts the value of the two.
//
// The rule is small but it has three parts that are easy to get wrong one at a time, which is why it
// is asserted as BEHAVIOUR by `scripts/verify-build-gate-failopen.mjs` in CI's no-install job rather
// than left as a shape someone has to notice in a 2,300-line function:
//
//   1. a reviewer that succeeds is returned EXACTLY as it was — this wrapper adds no policy of its own;
//   2. a reviewer that throws yields the CODER'S OWN ops, not an empty list, so the work survives; and
//   3. the failure is reported (a reason, a flag), never silently swallowed into an apparent pass.
//
// Import-free on purpose: the guard runs with no `npm install`, so it must not reach Prisma, express
// or the AI client. The caller owns the logging and the wording.
//
// WHAT THIS MUST NOT DO: turn a failure into a success. It never invents a review verdict, never sets
// `approved`, and never returns a summary claiming an examination took place. A caller reading the
// result can always tell "the reviewer looked and found nothing" from "the reviewer never ran".

/**
 * Run the reviewer, keeping the coder's work whatever the reviewer does.
 *
 * @param {object} args
 * @param {Array} args.fileOps              the coder's operations — the work being protected
 * @param {() => Promise<object>} args.run  the reviewer call, invoked with no arguments
 * @returns {Promise<{ reviewed: object|null, fileOps: Array, failed: string|null }>}
 *   `reviewed` is the reviewer's own result when it ran, or null when it did not.
 *   `fileOps` is the reviewer's version when it ran, and the coder's version when it did not.
 */
export async function runReviewerFailOpen({ fileOps, run }) {
  const coderOps = Array.isArray(fileOps) ? fileOps : [];
  let reviewed = null;
  let failed = null;

  try {
    reviewed = await run();
  } catch (err) {
    // The message only — never the error object, which can carry provider payloads and, for an
    // InsufficientCreditsError, the account's balance.
    failed = (err && err.message) || String(err);
  }

  // A reviewer that resolved to nothing usable counts as not having run. `null`/`undefined` are the
  // obvious cases; a result with no `fileOps` array would otherwise be handed back and read
  // downstream as `fileOps = undefined`, which loses the work through a different door.
  if (failed || !reviewed || !Array.isArray(reviewed.fileOps)) {
    return {
      reviewed: null,
      fileOps: coderOps,
      failed: failed || 'the review returned no usable result',
    };
  }

  return { reviewed, fileOps: reviewed.fileOps, failed: null };
}

/**
 * The sentence the user is owed when the review did not run, or null when it did.
 *
 * Written here rather than at the call site so it cannot drift from the rule above, and phrased to
 * say BOTH things at once: the work was applied, and it is less checked than usual. Silence would
 * imply the code was reviewed; "found nothing" would be the opposite of what happened.
 */
export function reviewFailureNote(failed) {
  if (!failed) return null;
  return `\n\n// NOT REVIEWED: the review pass could not run — ${failed}. Your changes were still applied, but the second-opinion check did not happen, so treat this one as less checked than usual. Ask me to re-check it and I will run the review on its own.`;
}
