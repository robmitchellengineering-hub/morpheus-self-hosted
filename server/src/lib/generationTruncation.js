// What to do when a chunk of generated files comes back truncated.
//
// WHY THIS EXISTS. Measured 2026-09-29 on a correctly-configured instance (coder on `deepseek-flash`):
//
//   planner        2,341 out      5s
//   coder chunk 1  1,315 out      5s
//   coder chunk 2 21,437 out     74s
//   coder chunk 3 17,799 out     62s
//   coder chunk 4 24,000 out     82s   <- EXACTLY the step cap
//
// The last chunk hit `DEFAULT_STEP_MAX_TOKENS` and `invokeAI` raised OUTPUT_TRUNCATED. The chat pipeline
// answers exactly this by retrying the files ONE AT A TIME (chatWithMorpheus.js, "truncated — retrying one
// file at a time"), and it even keeps the files that truncate twice, reported rather than dropped. The
// backend path had none of that: the throw propagated, and because nothing is persisted until the whole
// generation finishes, FIVE successful model calls were discarded and the project kept only its plan.
//
// That is the whole of "the backend generation does not finish": not that the model is slow, and not only
// that persistence is late — it is that an anticipated, recoverable condition throws away everything.
//
// This module is the decision, extracted as a pure function so it can be asserted without a model, a key
// or a credit. The caller does the retrying; this says WHAT to do and why.

/** Does this error mean the completion was cut off by the token cap? */
export function isTruncation(err) {
  return String(err?.message || '').includes('OUTPUT_TRUNCATED');
}

/**
 * The plan for a chunk that truncated: retry each file on its own, from smallest expectation to largest.
 *
 * One file at a time is the pipeline's established answer, and it is the right one: a single file's full
 * content fits the step cap that a multi-file response overflowed. The order is the chunk's own order
 * rather than a guess at file size — the caller asked for these files together for a reason (they belong
 * to one step), and reordering would make the retry's output harder to correlate with the first attempt.
 *
 * @returns {{ retry: string[], keep: string[], reason: string }}
 *   `retry` is the files to attempt individually; `keep` is what was already recovered, if anything.
 */
export function truncationPlan(chunk) {
  const files = (Array.isArray(chunk) ? chunk : []).filter((p) => typeof p === 'string' && p);
  return {
    retry: [...files],
    keep: [],
    reason: `a ${files.length}-file step overflowed the token cap, so each file is retried on its own`,
  };
}

/**
 * What a chunk's outcome means for the run, once the per-file retries have been attempted.
 *
 * `unwritten` is REPORTED, never silently dropped. A backend that is missing one file and says so is
 * usable and fixable on the next turn; one that reports success over a missing file is the failure this
 * whole area keeps producing. That is also the rule chatWithMorpheus.js settled on: name it, keep going.
 */
export function truncationOutcome({ recovered = [], unwritten = [] }) {
  return {
    recoveredCount: recovered.length,
    unwritten,
    ok: unwritten.length === 0,
    note: unwritten.length === 0
      ? null
      : `${unwritten.length} file(s) could not be generated — the model's output was cut off by the token cap even one file at a time: ${unwritten.join(', ')}. Everything else in this backend is intact; ask again and I will finish those.`,
  };
}
