// Required CI gates — which named checks must have RUN for a change to count as
// verified at all.
//
// WHY "NOTHING FAILED" IS NOT THE SAME AS "THE GATES RAN"
//
// `getPullRequestChecks()` answers "did anything fail?". That is the wrong
// question on its own. GitHub does not create a `pull_request` workflow run when
// it cannot compute the merge commit, and it does not backfill the run once
// mergeability resolves — so a PR can carry a full set of green Netlify deploy
// previews and *no* CI run at all. Every present check passes, the combined
// state reads `passing`, and the merge engine's "no checks yet" grace does not
// apply because checks DO exist — just not the ones that verify the code.
//
// That is not hypothetical. On 2026-09-20 both #258 and #259 opened, showed
// green previews, and had no `guards (no install)` / `lint + build` check-suite
// for the head commit; the Actions run only appeared after the PR was closed and
// reopened. A green deploy preview must never be the only gate before
// production — that is the exact gap the CI workflow's own header describes.
//
// So a required gate is present AND successful, or it blocks the merge. `skipped`
// and `neutral` do NOT count: a gate that did not run verified nothing.
//
// This module is deliberately pure and imports nothing. It is asserted in CI's
// no-install guards job (hazard H4), which cannot load anything that reaches
// Prisma — so the logic that decides whether a merge is verified must not either.

// The conclusion a required gate must have. Anything else — including the
// `skipped` and `neutral` that a non-required check is allowed to have — fails.
export const REQUIRED_CHECK_CONCLUSION = 'success';

// The gates that verify morpheus-self-hosted itself. The names are the `name:`
// fields of the jobs in .github/workflows/ci.yml, and scripts/verify-merge-gates.mjs
// parses that workflow and fails if these drift apart — a rename on one side
// without the other would otherwise silently disable the requirement.
export const SELF_DEV_REQUIRED_CHECKS = ['guards (no install)', 'lint + build'];

/**
 * Decide whether every required gate ran and succeeded.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string|null}>} checks
 *        the combined check-runs/statuses for the head commit, as returned by
 *        getPullRequestChecks()
 * @param {string[]} [required] names that must be present and successful;
 *        empty means "this repo has no known gates", which keeps the previous
 *        behaviour for a target that configures no CI (e.g. a theme repo)
 * @returns {{ok: true, required: string[]}
 *         | {ok: false, required: string[], missing: string[], notSuccess: Array<{name: string, conclusion: string|null, status: string|null}>}}
 */
export function requiredGateVerdict(checks, required = []) {
  const list = (Array.isArray(required) ? required : []).filter((n) => typeof n === 'string' && n.trim() !== '');
  if (list.length === 0) return { ok: true, required: [] };

  // Names are matched exactly (after trimming whitespace): a required gate is
  // identified by the name the workflow declares, and case-folding would let a
  // differently-cased replacement satisfy the requirement. Drift is caught by
  // the ci.yml parity guard rather than absorbed here.
  const present = new Map();
  for (const c of Array.isArray(checks) ? checks : []) {
    if (!c || typeof c.name !== 'string') continue;
    const key = c.name.trim();
    if (!present.has(key)) present.set(key, c);
  }

  const missing = [];
  const notSuccess = [];
  for (const name of list) {
    const found = present.get(name.trim());
    if (!found) {
      missing.push(name);
      continue;
    }
    if ((found.conclusion ?? null) !== REQUIRED_CHECK_CONCLUSION) {
      notSuccess.push({ name, conclusion: found.conclusion ?? null, status: found.status ?? null });
    }
  }

  if (missing.length || notSuccess.length) return { ok: false, required: list, missing, notSuccess };
  return { ok: true, required: list };
}

/**
 * The operator-facing sentence for a failed verdict. Names the gates and the
 * concrete action, because "checks took too long" (what the caller would
 * otherwise say) misattributes a run that GitHub never created.
 *
 * @param {{missing: string[], notSuccess: Array<{name: string, conclusion: string|null}>}} verdict
 * @returns {string}
 */
export function requiredGateMessage(verdict) {
  const missing = verdict?.missing || [];
  const notSuccess = verdict?.notSuccess || [];
  const parts = [];

  if (missing.length) {
    parts.push(
      `GitHub never ran ${missing.length === 1 ? 'the check' : 'the checks'} that verify a change here (${missing.join(', ')}). `
      + 'Nothing has checked this pull request, so it was not merged. Close the pull request and reopen it so GitHub '
      + 'recomputes the merge commit and creates the run, then merge again.',
    );
  }
  for (const gate of notSuccess) {
    const why = gate.conclusion === 'skipped'
      ? 'was skipped'
      : `reported "${gate.conclusion ?? 'no conclusion'}"`;
    parts.push(`The check that verifies a change here (${gate.name}) ${why}, which verifies nothing — so it was not merged.`);
  }
  return parts.join(' ');
}
