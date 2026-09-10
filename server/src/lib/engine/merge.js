// Shared engine — MERGE. Poll a pull request's combined check state and
// squash-merge it once green, deleting the branch. Host-agnostic for any
// GitHub-repo target (self-dev today; a static-site plugin tenant later).
// The WordPress delivery adapter reuses this as-is — the PR lives on GitHub
// regardless of where the site is hosted.
//
// Branch protection / GitHub-native auto-merge isn't available on a private
// free-plan repo, which is why this poll-and-merge exists at all.
import { getPullRequestChecks, mergePullRequest, deleteBranch } from '../github.js';

// A PR with genuinely no checks configured should still be mergeable — but a
// host's checks take a little while to even appear after the PR opens, so
// don't treat "no checks yet" as "passing" until the PR is at least this old.
export const NO_CHECKS_GRACE_MS = 90 * 1000;

/**
 * @param {string} token
 * @param {string} repoFullName  "owner/repo"
 * @param {number} prNumber
 * @param {{ force?: boolean, commitTitle?: string }} [opts]
 * @returns {Promise<object>} one of:
 *   { merged: true, alreadyMerged?: true, prNumber, mergeCommitSha, commitUrl }
 *   { merged: false, state: 'pending'|'failed'|'conflict'|'merge_failed', prNumber, prUrl?, failing?, checks?, message?, note? }
 */
export async function mergePrWhenGreen(token, repoFullName, prNumber, opts = {}) {
  const { force = false, commitTitle } = opts;
  const commitUrlFor = (sha) => `https://github.com/${repoFullName}/commit/${sha}`;
  const prUrlFor = (n) => `https://github.com/${repoFullName}/pull/${n}`;

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
    // state === 'passing'
    if (checks.noChecks && checks.createdAt && (Date.now() - new Date(checks.createdAt).getTime()) < NO_CHECKS_GRACE_MS) {
      return { merged: false, state: 'pending', prNumber, checks: [], note: 'waiting for checks to register' };
    }
    if (checks.mergeable === false) {
      return { merged: false, state: 'conflict', prNumber, prUrl: prUrlFor(prNumber), message: 'This PR conflicts with the base branch — sync, re-apply the change, and push again.' };
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
