// Shared engine — MERGE. Poll a pull request's combined check state and
// squash-merge it once green, deleting the branch. Host-agnostic for any
// GitHub-repo target (self-dev today; a static-site plugin tenant later).
// The WordPress delivery adapter reuses this as-is — the PR lives on GitHub
// regardless of where the site is hosted.
//
// Branch protection / GitHub-native auto-merge isn't available on a private
// free-plan repo, which is why this poll-and-merge exists at all.
import { getPullRequestChecks, mergePullRequest, deleteBranch } from '../github.js';
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

  const { merged, mergeCommitSha } = await mergePullRequest(token, repoFullName, prNumber, {
    method: 'squash',
    commitTitle: commitTitle || `PR #${prNumber} (via Morpheus)`,
  });
  if (!merged) {
    return { merged: false, state: 'merge_failed', prNumber, prUrl: prUrlFor(prNumber), message: 'GitHub declined the merge — check the PR.' };
  }

  // Tidy up the throwaway branch — best effort.
  if (checks.headRef) {
    try { await deleteBranch(token, repoFullName, checks.headRef); } catch { /* leave it */ }
  }

  return { merged: true, prNumber, mergeCommitSha, commitUrl: commitUrlFor(mergeCommitSha), forced: force };
}
