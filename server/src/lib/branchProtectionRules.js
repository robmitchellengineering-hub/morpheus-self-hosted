// Does GitHub enforce the gates this repo says it requires?
//
// WHY THIS EXISTS
//
// Every other gate in this repo is enforced by something that can fail loudly:
// `merge.js` reads the check runs, `verify-merge-gates.mjs` fails if the declared
// names drift from the workflow's job names. Branch protection on `main` was
// different — it lived only in GitHub's settings, set by hand with a `gh api`
// call on 2026-09-24, and *nothing on disk described it*. Turn it off, rename a
// job, or add a gate to SELF_DEV_REQUIRED_CHECKS without adding it to the
// setting, and the repo would keep claiming three required checks while GitHub
// enforced two or none. That is hazard H17 with the sign flipped: a check that
// never runs reads as passed, and a requirement that was never enforced reads as
// enforced.
//
// So the comparison is pure and lives here, where it can be asserted in CI's
// no-install guards job (hazard H4) without a network call or a token. The live
// reading is `scripts/check-branch-protection.mjs`, which is deliberately NOT
// wired into `verify.mjs`: it needs `gh` and an authenticated token, and a gate
// that fails on a machine without either is not a gate, it is an outage.
//
// This module imports nothing.

/**
 * Compare the gates GitHub is enforcing against the gates this repo requires.
 *
 * `strict` and `adminsBypass` are reported but are NOT part of `ok`, because
 * both are set deliberately and neither is a correctness failure here:
 *
 *   * `strict` — "require branches to be up to date before merging" is ON since
 *     2026-09-24, once `server/src/lib/engine/merge.js` learned to answer a
 *     behind head by updating the branch and reporting pending rather than
 *     attempting a merge GitHub will refuse. Turning it on before that is what
 *     would have broken self-dev's auto-merge, so if this ever reads `false`,
 *     something turned a real requirement back off.
 *   * `adminsBypass: true` — an admin can still merge with `--admin`. That is
 *     the emergency path, and it is deliberate: on 2026-09-24 the Actions
 *     minutes ran out and no check could run at all, so with admin enforcement
 *     ON nothing could have merged until the quota reset. It is also the one
 *     case a pull request's checks do not cover, which is why the CI workflow
 *     keeps a manual `workflow_dispatch` entry point.
 *
 * Both are printed every run so that a change to either is visible rather than
 * silent.
 *
 * @param {object|null} protection the object returned by
 *        GET /repos/{owner}/{repo}/branches/main/protection, or null/undefined
 *        when the branch is unprotected (GitHub answers 404)
 * @param {string[]} required names that must be enforced, from
 *        SELF_DEV_REQUIRED_CHECKS
 * @returns {{ok: boolean, required: string[], enforced: string[], missing: string[],
 *            extra: string[], unprotected: boolean, strict: boolean,
 *            forcePushes: boolean, deletions: boolean, adminsBypass: boolean}}
 */
export function protectionVerdict(protection, required = []) {
  const wanted = (Array.isArray(required) ? required : [])
    .filter((n) => typeof n === 'string' && n.trim() !== '')
    .map((n) => n.trim());

  const ctx = protection?.required_status_checks?.contexts;
  const enforced = Array.isArray(ctx) ? ctx.map((s) => String(s).trim()) : [];

  // No protection object at all means no requirement is enforced, which is the
  // loudest failure this module can report — not a `missing` list that happens to
  // be every name.
  const unprotected = !protection || protection.required_status_checks == null;

  const missing = unprotected ? wanted.slice() : wanted.filter((n) => !enforced.includes(n));
  // A gate GitHub enforces that this repo does not declare is also drift: it
  // blocks merges on something nothing on disk explains, and nobody would know
  // which change introduced it.
  const extra = unprotected ? [] : enforced.filter((n) => !wanted.includes(n));

  const forcePushes = protection?.allow_force_pushes?.enabled === true;
  const deletions = protection?.allow_deletions?.enabled === true;
  const strict = protection?.required_status_checks?.strict === true;

  // `strict` is judged, because the repo now depends on it: a pull request is
  // verified against the exact base its squash lands on, and merge.js answers a
  // behind head by updating it. Turn "up to date" off and that guarantee goes
  // quietly — a head verified against a stale base still reads as green.
  //
  // `adminsBypass` is NOT judged. It is the deliberate emergency path, and a
  // check that calls a decision drift is noise that gets ignored.
  const ok = !unprotected && missing.length === 0 && extra.length === 0 && !forcePushes && !deletions && strict;

  return {
    ok,
    required: wanted,
    enforced,
    missing,
    extra,
    unprotected,
    strict,
    forcePushes,
    deletions,
    adminsBypass: protection?.enforce_admins?.enabled !== true,
  };
}

/**
 * The operator-facing sentence for a verdict. Names what is wrong and what to do
 * about it, because "branch protection differs" would send the reader to the
 * GitHub settings UI with no idea which field to change.
 *
 * @param {ReturnType<typeof protectionVerdict>} verdict
 * @returns {string}
 */
export function protectionMessage(verdict) {
  if (verdict.ok) {
    const parts = [
      `main enforces ${verdict.required.length} required check${verdict.required.length === 1 ? '' : 's'} `
      + `(${verdict.required.join(', ')}); branches must be up to date before merging, and force-pushes and branch deletion are blocked.`,
    ];
    if (verdict.adminsBypass) parts.push('Admins can bypass (deliberate: the emergency path when CI cannot run at all — after one, run the CI workflow by hand).');
    return parts.join(' ');
  }

  const parts = [];
  if (verdict.unprotected) {
    parts.push('main has NO branch protection, so none of the required checks are enforced by GitHub — they are only enforced by merge.js.');
  }
  if (verdict.missing.length) {
    parts.push(`GitHub is not enforcing: ${verdict.missing.join(', ')}. Add ${verdict.missing.length === 1 ? 'it' : 'them'} under Settings → Branches → main → Require status checks to pass.`);
  }
  if (verdict.extra.length) {
    parts.push(`GitHub requires checks this repo does not declare: ${verdict.extra.join(', ')}. Either add them to SELF_DEV_REQUIRED_CHECKS or remove them from the branch protection rule.`);
  }
  // The silent one: with this off, a head verified against a stale base still
  // reads as green, so nothing looks wrong until two good changes break main.
  if (!verdict.unprotected && !verdict.strict) {
    parts.push('Branches are NOT required to be up to date before merging. Turn on "Require branches to be up to date before merging" — merge.js handles a behind head by updating it, so there is no reason for this to be off.');
  }
  if (verdict.forcePushes) parts.push('Force-pushes to main are allowed; they should be blocked.');
  if (verdict.deletions) parts.push('Deleting main is allowed; it should be blocked.');
  return parts.join(' ');
}
