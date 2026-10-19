// Shared engine — MERGE. Poll a pull request's combined check state and
// squash-merge it once green, deleting the branch. Host-agnostic for any
// GitHub-repo target (self-dev today; a static-site plugin tenant later).
// The WordPress delivery adapter reuses this as-is — the PR lives on GitHub
// regardless of where the site is hosted.
//
// Branch protection exists on this account (GitHub Pro, since 2026-09-24), so
// `main` is enforced server-side as well as by the gate below. That is why a head
// behind its base has to be brought up to date rather than merged, and why a
// merge declined by policy has to be reported rather than thrown. The poll-and-
// merge still exists because it drives self-dev's own pull requests — not because
// GitHub cannot do it.
import { getPullRequestChecks, mergePullRequest, deleteBranch, updatePullRequestBranch } from '../github.js';
import { requiredGateVerdict, requiredGateMessage } from './requiredChecks.js';

// A PR with genuinely no checks configured should still be mergeable — but a
// host's checks take a little while to even appear after the PR opens, so
// don't treat "no checks yet" as "passing" until the PR is at least this old.
export const NO_CHECKS_GRACE_MS = 90 * 1000;

/**
 * @param {string} token
 * @param {string} repoFullName  "owner/repo"
 * @param {number} prNumber
 * @param {{ force?: boolean, commitTitle?: string, requiredChecks?: string[] }} [opts]
 *   `requiredChecks` are the named gates that must have RUN and succeeded
 *   (see requiredChecks.js). Empty/absent keeps the old behaviour for a target
 *   with no known CI — a repo whose checks are all green still merges.
 * @returns {Promise<object>} one of:
 *   { merged: true, alreadyMerged?: true, prNumber, mergeCommitSha, commitUrl }
 *   { merged: false, state: 'pending'|'failed'|'conflict'|'merge_failed', prNumber, prUrl?, failing?, checks?, missingChecks?, unverifiedChecks?, message?, note? }
 */
export async function mergePrWhenGreen(token, repoFullName, prNumber, opts = {}) {
  const { force = false, commitTitle, requiredChecks = [] } = opts;
  const commitUrlFor = (sha) => `https://github.com/${repoFullName}/commit/${sha}`;
  const prUrlFor = (n) => `https://github.com/${repoFullName}/pull/${n}`;
  const withinGrace = (c) => !!c.createdAt && (Date.now() - new Date(c.createdAt).getTime()) < NO_CHECKS_GRACE_MS;


  const checks = await getPullRequestChecks(token, repoFullName, prNumber);

  if (checks.state === 'merged') {
    return { merged: true, alreadyMerged: true, prNumber, mergeCommitSha: checks.mergedSha, commitUrl: checks.mergedSha ? commitUrlFor(checks.mergedSha) : null };
  }

  if (!force) {
    if (checks.state === 'failed') {
      return { merged: false, state: 'failed', prNumber, prUrl: prUrlFor(prNumber), failing: checks.failing || [], checks: checks.checks || [] };
    }
    if (checks.state === 'pending') {
      return { merged: false, state: 'pending', prNumber, checks: checks.checks || [] };
    }
    // state === 'passing'. A conflict is answered first: GitHub cannot build the
    // merge commit, which is exactly why this PR's workflow run never appeared.
    // Reporting "the checks never ran" here would name the symptom and hide the
    // cause the operator has to act on.
    if (checks.mergeable === false) {
      return { merged: false, state: 'conflict', prNumber, prUrl: prUrlFor(prNumber), message: 'This PR conflicts with the base branch — sync, re-apply the change, and push again.' };
    }

    // A head that is behind its base. Branch protection requires branches to be up
    // to date, so GitHub refuses this merge with a 405 even though every check on
    // the head is green. Updating is not a retry — it lands a merge commit on the
    // head, which re-runs the required checks, so the green read above is not the
    // green that gets merged. Hence: update, and report pending rather than merge.
    //
    // This is answered before the gate verdict below on purpose. A run that never
    // appeared and a head that is about to be replaced look identical from here,
    // and telling the operator to close and reopen the PR when the real answer is
    // "it was one commit behind" sends them to fix the wrong thing.
    if (checks.mergeableState === 'behind') {
      const updated = await updatePullRequestBranch(token, repoFullName, prNumber);
      if (!updated.ok) {
        return {
          merged: false, state: 'merge_failed', prNumber, prUrl: prUrlFor(prNumber),
          message: `This PR is behind its base branch and GitHub would not update it: ${updated.message}`,
        };
      }
      return {
        merged: false, state: 'pending', prNumber, prUrl: prUrlFor(prNumber), checks: checks.checks || [],
        note: 'branch updated — waiting for the checks to run again against the new head',
        message: 'This PR was behind its base branch, so it was brought up to date. The required checks are re-running against the new head — merge again once they are green.',
      };
    }

    // Then: the gates that verify a change must have RUN, not merely have failed
    // to fail. A green deploy preview with no CI run behind it reads as `passing`
    // above — see requiredChecks.js for the incident, and why "no checks yet" is
    // not the same as "checks exist but the workflow was never created".
    const gate = requiredGateVerdict(checks.checks, requiredChecks);
    if (!gate.ok) {
      if (withinGrace(checks)) {
        return { merged: false, state: 'pending', prNumber, checks: checks.checks || [], note: 'waiting for the required checks to register' };
      }
      return {
        merged: false, state: 'failed', prNumber, prUrl: prUrlFor(prNumber),
        requiredChecks: gate.required, missingChecks: gate.missing, unverifiedChecks: gate.notSuccess,
        message: requiredGateMessage(gate),
      };
    }

    if (checks.noChecks && withinGrace(checks)) {
      return { merged: false, state: 'pending', prNumber, checks: [], note: 'waiting for checks to register' };
    }
  }

  let mergeResult;
  try {
    mergeResult = await mergePullRequest(token, repoFullName, prNumber, {
      method: 'squash',
      commitTitle: commitTitle || `PR #${prNumber} (via Morpheus)`,
    });
  } catch (err) {
    // GitHub enforces branch protection as well as the gate above, so a merge can
    // be declined for a reason this function never checked: a required context
    // GitHub expects but never received, a rule added to main since, or a check
    // that a re-run invalidated. Until 2026-09-24 this call could not throw in
    // practice, because main was unprotected — so the throw escaped as an
    // exception instead of the `merge_failed` state the caller renders.
    //
    // The API's own sentence is the whole value here: "the base branch policy
    // prohibits the merge" tells an operator which setting to look at, while
    // "check the PR" sends them to read a page that looks green.
    const said = String(err?.details?.message || err?.message || '').trim();
    const policy = err?.status === 405 && /branch policy|protected branch/i.test(said);
    return {
      merged: false,
      state: 'merge_failed',
      prNumber,
      prUrl: prUrlFor(prNumber),
      message: policy
        ? `${said.replace(/\.?$/, '.')} Every gate above passed, so main requires something this engine does not know about — run \`node scripts/check-branch-protection.mjs\` to see exactly what main enforces.`
        : `GitHub declined the merge${said ? `: ${said}` : ''}.`,
    };
  }

  const { merged, mergeCommitSha } = mergeResult;
  if (!merged) {
    return { merged: false, state: 'merge_failed', prNumber, prUrl: prUrlFor(prNumber), message: 'GitHub accepted the request but reported the pull request was not merged.' };
  }

  // Tidy up the throwaway branch — best effort.
  if (checks.headRef) {
    try { await deleteBranch(token, repoFullName, checks.headRef); } catch { /* leave it */ }
  }

  return { merged: true, prNumber, mergeCommitSha, commitUrl: commitUrlFor(mergeCommitSha), forced: force };
}
