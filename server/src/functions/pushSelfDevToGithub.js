// Self-dev "PUSH TO PRODUCTION": ships the current state of the singleton
// self_dev workspace to the REAL morpheus-self-hosted repo.
//
// The diff-and-push machinery now lives in the shared engine
// (server/src/lib/engine/ship.js) and is reached through the 'self-dev'
// delivery adapter. This function keeps the self-dev-specific parts:
//   - the admin gate + the esbuild verify gate (force overrides)
//   - the schema-change-needs-a-migration gate (run as the ship precheck)
//   - manual-source detection + decision-ref stamp
//   - after a direct push: apply any selfdev-*.sql the change brought in
//   - the operator-facing chat notes
//
// Default path: land the change on a throwaway `self-dev/<ts>` branch and
// open a PR (Netlify builds a deploy preview as a second gate; mergeSelfDevPr
// squash-merges once green). `force` or `directToMain:true` commits straight
// to main, the original behaviour.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { SELF_DEV_OWNER, SELF_DEV_REPO, SELF_DEV_REPO_FULL_NAME, SELF_DEV_BRANCH, isAppendOnlyDiff, isSingleLineRemoval } from '../lib/selfDevRepo.js';
import { getDeliveryAdapter } from '../lib/delivery/index.js';
import { SELF_DEV_ADMIN_MANUAL_SOURCES } from './generateSelfDevManual.js';
import { runVerifySelfDev } from './verifySelfDev.js';
import { SCHEMA_PATH, MIGRATION_RE } from '../lib/selfDevMigrations.js';
import { stampDecisionRef } from '../lib/selfDevDecisions.js';
import { scopeExcludeFor, resolvePolicy } from '../lib/enginePolicy.js';
import { getGithubToken, getFileContent } from '../lib/github.js';
import { evaluateDrift, isMissingSyncedCommitColumn } from '../lib/selfDevDrift.js';

const GH_API = 'https://api.github.com';

// The project's recorded sync point, or null when unknown (pre-migration
// workspace, or the column read failed). Never throws — an unknown sync point
// degrades to the guard's deletion-shape check.
async function readSyncedCommit(projectId) {
  try {
    const row = await prisma.project.findFirst({ where: { id: projectId }, select: { synced_commit: true } });
    return row?.synced_commit ?? null;
  } catch (err) {
    if (isMissingSyncedCommitColumn(err)) return null;
    throw err;
  }
}

// The base branch's current HEAD commit. Null on any failure, which leaves the
// drift check to the deletion-shape half rather than blocking a legitimate push.
async function readRemoteHead(user) {
  try {
    const token = await getGithubToken(user.id);
    const res = await fetch(`${GH_API}/repos/${SELF_DEV_OWNER}/${SELF_DEV_REPO}/git/ref/heads/${SELF_DEV_BRANCH}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Morpheus' },
    });
    if (!res.ok) return null;
    return (await res.json()).object?.sha || null;
  } catch {
    return null;
  }
}

// The one file every widget-build must append itself to — shared across
// every user's builds, so its OWN staleness matters even under a scoped
// push (see the precheck below and enginePolicy.js's WIDGET_BUILD).
const DECK_WIDGETS_REGISTRY_PATH = 'src/pages/CommandDeck/deckWidgets.js';

export default async function handler({ user, body }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });

  const { projectId, force, scopePolicy } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id, project_type: 'self_dev' },
  });
  if (!project) throw Object.assign(new Error('Self-dev project not found'), { status: 404 });

  // Verify gate (esbuild syntax + cross-file import/export). `force` overrides.
  if (!force) {
    const verify = await runVerifySelfDev(user);
    if (!verify.ok) {
      return {
        blocked: true,
        verify,
        repoFullName: SELF_DEV_REPO_FULL_NAME,
        message: `Push blocked — verification found ${verify.errorCount} error(s). Fix them (or push again with force to override).`,
      };
    }
  }

  const localFiles = await prisma.projectFile.findMany({ where: { project_id: projectId } });

  const directToMain = !!force || body?.directToMain === true;

  // A scoped push (e.g. a Jarvis-triggered widget build, or a widget
  // deletion) never diffs or deletes a path outside its own policy's
  // allow-list — structurally, not by trusting the local workspace to be
  // fresh (KNOWN-HAZARDS.md H9). Absent for a normal admin push: full-repo
  // diff, unchanged behaviour. `scopePolicy` may be a registered policy id
  // (e.g. 'widget_build') or, for a per-call scope like a single widget's
  // deletion, a raw ad-hoc policy object — resolvePolicy() accepts both.
  const resolvedScopePolicy = scopePolicy ? resolvePolicy(scopePolicy) : null;
  const scopeExclude = resolvedScopePolicy ? scopeExcludeFor(resolvedScopePolicy) : undefined;

  // A2 — a schema.prisma change must ship its migration in the same push.
  // Run as the ship precheck so it fires after the diff, before the push.
  const precheck = async ({ changedPaths, deletePaths = [] }) => {
    // ── H9 drift guard ──────────────────────────────────────────────────────
    // shipChange() diffs the local mirror against the LIVE remote tree and
    // treats every remote path absent locally as a deletion. A stale workspace
    // therefore does not just miss upstream work — it DELETES it. Incident H9
    // removed ~45 files this way, including a shipped security fix.
    const drift = evaluateDrift({
      syncedCommit: await readSyncedCommit(projectId),
      remoteHead: await readRemoteHead(user),
      deleteCount: deletePaths.length,
      scoped: !!resolvedScopePolicy,
      directToMain,
    });
    if (drift) {
      return { blocked: true, ...drift, repoFullName: SELF_DEV_REPO_FULL_NAME };
    }

    const schemaChanged = changedPaths.includes(SCHEMA_PATH);
    const hasMigration = changedPaths.some((p) => MIGRATION_RE.test(p));
    if (schemaChanged && !hasMigration && !directToMain) {
      return {
        blocked: true,
        reason: 'schema-no-migration',
        repoFullName: SELF_DEV_REPO_FULL_NAME,
        message: 'server/prisma/schema.prisma changed but no server/prisma/selfdev-<slug>.sql migration is included. Ask Morpheus to add the migration file (additive, idempotent DDL) in the same change, then push again — or push with force to skip.',
      };
    }

    // deckWidgets.js is in scope for both a widget build (appending an
    // entry) and a widget deletion (removing one), so it's diffed
    // normally, not excluded — meaning its OWN staleness still matters.
    // Check the new content against the file's LIVE remote content (not
    // the possibly-stale local copy) so neither operation can ever
    // silently take another widget's entry along with it.
    if (changedPaths.includes(DECK_WIDGETS_REGISTRY_PATH) && (resolvedScopePolicy?.id === 'widget_build' || resolvedScopePolicy?.id === 'widget_delete')) {
      const token = await getGithubToken(user.id);
      const remote = await getFileContent(SELF_DEV_OWNER, SELF_DEV_REPO, DECK_WIDGETS_REGISTRY_PATH, SELF_DEV_BRANCH, token);
      const newContent = localFiles.find((f) => f.path === DECK_WIDGETS_REGISTRY_PATH)?.content ?? '';
      const isBuild = resolvedScopePolicy.id === 'widget_build';
      const ok = !remote || (isBuild ? isAppendOnlyDiff(remote.content, newContent) : isSingleLineRemoval(remote.content, newContent, resolvedScopePolicy.widgetKey));
      if (!ok) {
        return {
          blocked: true,
          reason: isBuild ? 'deckwidgets-not-additive' : 'deckwidgets-not-pure-removal',
          repoFullName: SELF_DEV_REPO_FULL_NAME,
          message: isBuild
            ? `${DECK_WIDGETS_REGISTRY_PATH} changed something other than a pure addition — it's shared by every widget, so a scoped build may only append its own entry. Re-sync the workspace and try again.`
            : `${DECK_WIDGETS_REGISTRY_PATH} changed something other than removing exactly the '${resolvedScopePolicy.widgetKey}' entry — it's shared by every widget, so a deletion may only remove its own entry. Re-sync the workspace and try again.`,
        };
      }
    }

    return null;
  };

  const result = await getDeliveryAdapter('self-dev').ship({ user, files: localFiles, directToMain, precheck, scopeExclude });

  // Blocked by the precheck.
  if (result.blocked) return result;

  // Nothing to push.
  if (result.shipped === false) {
    return {
      fileCount: 0, createCount: 0, updateCount: 0, deleteCount: 0, commitUrl: null,
      repoFullName: SELF_DEV_REPO_FULL_NAME, branch: SELF_DEV_BRANCH,
      message: 'No changes to push — workspace already matches production.',
    };
  }

  const { changedPaths = [], createCount, updateCount, deleteCount, summary } = result;
  const fileCount = createCount + updateCount + deleteCount;
  const touchedManualSource = changedPaths.some((p) => SELF_DEV_ADMIN_MANUAL_SOURCES.includes(p));
  const schemaOrMigration = changedPaths.includes(SCHEMA_PATH) || changedPaths.some((p) => MIGRATION_RE.test(p));

  if (result.mode === 'direct') {
    const { commitSha, branch, commitUrl } = result;

    await prisma.chatMessage.create({
      data: {
        created_by_id: user.id, project_id: projectId, role: 'morpheus',
        content: `Pushed straight to ${SELF_DEV_REPO_FULL_NAME}@${branch} (${commitSha.substring(0, 7)}): ${summary}. Northflank and Netlify redeploy from here. Welcome to the real world.`,
      },
    });
    await logUsage(user.id, 'self_dev_push', projectId, project.name, {
      mode: 'direct', createCount, updateCount, deleteCount, commitSha,
    });
    await stampDecisionRef(projectId, commitSha.slice(0, 7));

    // The mirror now matches what we just pushed, so record it — otherwise the
    // next push would see drift the moment this commit became main's HEAD.
    try {
      await prisma.project.update({ where: { id: projectId }, data: { synced_commit: commitSha } });
    } catch (err) {
      if (!isMissingSyncedCommitColumn(err)) throw err;
    }

    if (touchedManualSource) {
      try {
        const { runGenerateSelfDevManual } = await import('./generateSelfDevManual.js');
        await runGenerateSelfDevManual(user, 'auto:push');
      } catch (err) {
        console.error('[pushSelfDevToGithub] manual regen failed (push succeeded):', err.message);
      }
    }

    let migrations = null;
    if (schemaOrMigration) {
      try {
        const { runApplySelfDevMigrations } = await import('./applySelfDevMigrations.js');
        migrations = await runApplySelfDevMigrations(user, { projectId });
      } catch (err) {
        console.error('[pushSelfDevToGithub] migration apply failed (push succeeded):', err.message);
        migrations = { error: err.message };
      }
    }

    return {
      mode: 'direct', fileCount, createCount, updateCount, deleteCount,
      commitUrl, repoFullName: SELF_DEV_REPO_FULL_NAME, branch, commitSha, migrations,
    };
  }

  // ── PR mode ─────────────────────────────────────────────────────────────
  const { prNumber, prUrl, branch, headSha } = result;

  await prisma.chatMessage.create({
    data: {
      created_by_id: user.id, project_id: projectId, role: 'morpheus',
      content: `Opened PR #${prNumber} (\`${branch}\`) with ${summary}. Netlify is building a deploy preview now — I'll squash-merge to main automatically once every check passes. ${prUrl}`,
    },
  });
  await logUsage(user.id, 'self_dev_push', projectId, project.name, {
    mode: 'pr', prNumber, createCount, updateCount, deleteCount, headSha,
  });
  await stampDecisionRef(projectId, `PR #${prNumber}`);

  return {
    mode: 'pr', prNumber, prUrl, branch, headSha,
    fileCount, createCount, updateCount, deleteCount,
    touchedManualSource,
    hasMigration: schemaOrMigration,
    repoFullName: SELF_DEV_REPO_FULL_NAME,
  };
}
