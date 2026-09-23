// The pre-call reservation's output-token number, as a pure rule.
//
// WHY THIS IS ITS OWN MODULE
//
// `billing.js` reaches the Prisma client through `db.js`, so a guard that wants
// to test this rule cannot import it — CI's guards job installs nothing, and
// `verify-guards-no-install.mjs` fails any guard that can reach a bare package.
// The clamp rule hit exactly this and was factored out into `billingClamp.js`;
// this is the same move for the same reason, so the number can be asserted as
// behaviour instead of read as text.
//
// THE RULE
//
// The caller's own bound wins, and the per-role guess is only the fallback for a
// caller that passed no cap. That is not a preference — it is what makes the
// reservation honest. `reserveCredits` is a hard hold with no overdraft grace,
// so an under-estimate does not merely under-charge later: it lets a call
// through whose real cost the balance could not cover.
//
// It was wrong until 2026-09-23. The SEO batch caps a call at
// `seoCallMaxTokens(5)` = 8,000 output tokens and reserved against a 2,000 guess
// inherited from `diagnosis` — 4x under, and 8x for the 25-item call the same
// endpoint accepts (16,000). Rob, told about it: "Well raise it it needs to
// work."
//
// Reconciliation still refunds the difference against actual usage, so
// reserving the bound is the conservative direction the estimator was always
// documented to take — see ESTIMATE_SAFETY_MULTIPLIER in billing.js.

/** Per-role output-token expectations. A fallback, never the rule. */
export const ROLE_OUTPUT_ESTIMATE = {
  planner: 1500,
  coder: 3000,
  reviewer: 1500,
  diagnosis: 2000,
  // The SEO batch's own cap: the honest fallback for a caller that does not
  // bound the call. See seoCallMaxTokens() in seoPrompts.js.
  seo: 8000,
};

export const DEFAULT_OUTPUT_ESTIMATE = 1500;

/**
 * How many output tokens to reserve against.
 *
 * A cap that is present but nonsense must fall back to the role's number rather
 * than reserve zero — `maxTokens: NaN` or `0` silently reserving nothing would
 * reintroduce exactly the under-reservation this exists to remove, and it would
 * do it quietly.
 *
 * @param {string} role
 * @param {number} [maxTokens] the cap the caller runs the call under
 * @returns {number}
 */
export function estimateOutputTokens(role, maxTokens) {
  const cap = Math.trunc(Number(maxTokens));
  if (Number.isFinite(cap) && cap > 0) return cap;
  return ROLE_OUTPUT_ESTIMATE[role] || DEFAULT_OUTPUT_ESTIMATE;
}
