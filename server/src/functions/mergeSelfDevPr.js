// Auto-merge the self-dev PR opened by pushSelfDevToGithub.js once its checks
// are green (Command Deck: self-dev replaces the dev loop, Tier 1 #2).
//
// The SelfDev page polls this after a PR-mode push. Each call reads the PR's
// combined check state (Checks API + commit-status API) and:
//   - 'pending'  → return, the page polls again shortly
//   - 'failed'   → return the failing check names; main is left untouched,
//                  the page shows "view PR / MERGE ANYWAY"
//   - 'passing'  → squash-merge the PR, delete the branch, drop a chat note,
//                  return the merge commit so the page's deploy watcher +
//                  REVERT LAST PUSH take over on it
//
// `force: true` (the page's MERGE ANYWAY button) merges regardless of check
// state — the operator has decided a red check is a false positive, same
// escape hatch as pushSelfDevToGithub's `force`.
//
// Branch protection / GitHub-native auto-merge isn't available on this repo
// (private, free plan), which is why this poll-and-merge lives here instead.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import {
  getGithubToken, getPullRequestChecks, mergePullRequest, deleteBranch,
} from '../lib/github.js';
import { SELF_DEV_REPO_FULL_NAME } from '../lib/selfDevRepo.js';

// A PR with genuinely no checks configured should still be mergeable — but
// Netlify's checks take a little while to even appear after the PR opens, so
// don't treat "no checks yet" as "passing" until the PR is at least this old.
const NO_CHECKS_GRACE_MS = 90 * 1000;

const commitUrlFor = (sha) => `https://github.com/${SELF_DEV_REPO_FULL_NAME}/commit/${sha}`;
const prUrlFor = (n) => `https://github.com/${SELF_DEV_REPO_FULL_NAME}/pull/${n}`;

export async function runMergeSelfDevPr(user, prNumber, { force = false, projectId = null, touchedManualSource = false, hasMigration = false } = {}) {
  const token = await getGithubToken(user.id);
  const checks = await getPullRequestChecks(token, SELF_DEV_REPO_FULL_NAME, prNumber);

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
      return { merged: false, state: 'conflict', prNumber, prUrl: prUrlFor(prNumber), message: 'This PR conflicts with main — SYNC FROM GITHUB, re-apply the change, and push again.' };
    }
  }

  const { merged, mergeCommitSha } = await mergePullRequest(token, SELF_DEV_REPO_FULL_NAME, prNumber, {
    method: 'squash',
    commitTitle: `Self-dev PR #${prNumber} (via Morpheus)`,
  });
  if (!merged) {
    return { merged: false, state: 'merge_failed', prNumber, prUrl: prUrlFor(prNumber), message: 'GitHub declined the merge — check the PR.' };
  }
  let migrations = null;

  // Tidy up the throwaway branch — best effort.
  if (checks.headRef) {
    try { await deleteBranch(token, SELF_DEV_REPO_FULL_NAME, checks.headRef); } catch { /* leave it */ }
  }

  const project = projectId
    ? await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id, project_type: 'self_dev' } })
    : await prisma.project.findFirst({ where: { created_by_id: user.id, project_type: 'self_dev' } });

  if (project) {
    await prisma.chatMessage.create({
      data: {
        created_by_id: user.id, project_id: project.id, role: 'morpheus',
        content: `Merged PR #${prNumber} → main (${mergeCommitSha.slice(0, 7)})${force ? ' — forced past a red check' : ', all checks green'}. Northflank and Netlify are redeploying production from here. REVERT LAST PUSH rolls this one merge back.`,
      },
    });
    await logUsage(user.id, 'self_dev_pr_merge', project.id, project.name, { prNumber, mergeCommitSha, forced: force });

    if (touchedManualSource) {
      try {
        const { runGenerateSelfDevManual } = await import('./generateSelfDevManual.js');
        await runGenerateSelfDevManual(user, 'auto:push');
      } catch (err) {
        console.error('[mergeSelfDevPr] manual regen failed (merge succeeded):', err.message);
      }
    }

    // A2 — apply any selfdev-*.sql the merge brought in, so the DB matches the
    // code before Northflank finishes redeploying. Additive-only; risky ones
    // are reported, not run. Best-effort — the merge already happened.
    if (hasMigration) {
      try {
        const { runApplySelfDevMigrations } = await import('./applySelfDevMigrations.js');
        migrations = await runApplySelfDevMigrations(user, { projectId: project.id });
      } catch (err) {
        console.error('[mergeSelfDevPr] migration apply failed (merge succeeded):', err.message);
        migrations = { error: err.message };
      }
    }
  }

  return { merged: true, prNumber, mergeCommitSha, commitUrl: commitUrlFor(mergeCommitSha), migrations };
}

export default async function handler({ user, body }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });

  const prNumber = Number(body?.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw Object.assign(new Error('A numeric prNumber is required'), { status: 400 });
  }

  return runMergeSelfDevPr(user, prNumber, {
    force: body?.force === true,
    projectId: body?.projectId || null,
    touchedManualSource: body?.touchedManualSource === true,
    hasMigration: body?.hasMigration === true,
  });
}
