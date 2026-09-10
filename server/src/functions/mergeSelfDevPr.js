// Auto-merge the self-dev PR opened by pushSelfDevToGithub.js once its checks
// are green (Command Deck: self-dev replaces the dev loop, Tier 1 #2).
//
// The SelfDev page polls this after a PR-mode push. The poll-and-squash-merge
// logic now lives in the shared engine (server/src/lib/engine/merge.js) and
// is reached through the 'self-dev' delivery adapter:
//   - 'pending'  → the page polls again shortly
//   - 'failed'   → the failing check names; main is left untouched
//   - 'conflict' → sync + re-apply + push again
//   - merged     → this function drops the chat note, logs usage, regenerates
//                  the manual and applies any migration the merge brought in
//
// `force: true` (the page's MERGE ANYWAY button) merges regardless of check
// state — the operator has decided a red check is a false positive.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { getDeliveryAdapter } from '../lib/delivery/index.js';

export async function runMergeSelfDevPr(user, prNumber, { force = false, projectId = null, touchedManualSource = false, hasMigration = false } = {}) {
  const result = await getDeliveryAdapter('self-dev').merge({ user, prNumber, force });

  // Not merged this call (pending / failed / conflict / merge_failed), or it
  // was already merged on a previous call — nothing more to do.
  if (result.merged !== true || result.alreadyMerged) {
    return result;
  }

  const { mergeCommitSha } = result;
  let migrations = null;

  const project = projectId
    ? await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id, project_type: 'self_dev' } })
    : await prisma.project.findFirst({ where: { created_by_id: user.id, project_type: 'self_dev' } });

  if (project) {
    await prisma.chatMessage.create({
      data: {
        created_by_id: user.id, project_id: project.id, role: 'morpheus',
        content: `Merged PR #${prNumber} → main (${mergeCommitSha.slice(0, 7)})${result.forced ? ' — forced past a red check' : ', all checks green'}. Northflank and Netlify are redeploying production from here. REVERT LAST PUSH rolls this one merge back.`,
      },
    });
    await logUsage(user.id, 'self_dev_pr_merge', project.id, project.name, { prNumber, mergeCommitSha, forced: result.forced });

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

  return { merged: true, prNumber, mergeCommitSha, commitUrl: result.commitUrl, migrations };
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
