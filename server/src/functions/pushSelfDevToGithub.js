// Self-dev "PUSH TO PRODUCTION": ships the current state of the singleton
// self_dev workspace to the REAL morpheus-self-hosted repo.
//
// Default path (2026-09-09): land the change on a throwaway `self-dev/<ts>`
// branch and open a PR. Netlify builds a deploy preview as a second gate
// over the local esbuild verify, and mergeSelfDevPr.js squash-merges to main
// once every check is green — so main (which Northflank + Netlify deploy
// production from) only ever moves via a verified merge, and a broken change
// never reaches a deploy. `force` (verify override / hotfix) or
// `directToMain:true` commits straight to main, the original behaviour.
//
// How it decides what to push:
//  1. Diff the local workspace (ProjectFile rows) against the remote git
//     tree by git-blob SHA — so an unchanged file is never re-pushed. This
//     is why the operator's "no changes to push" is a real, cheap check and
//     a typical push is a handful of files, not the whole ~470-file repo.
//  2. Deletions: a remote path missing locally is only treated as a real
//     deletion if it's one self-dev actually MIRRORS — i.e. shouldExclude()
//     is false for it. base44/, the lock files and every binary are excluded
//     from the workspace by importSelfDevRepo, so they must never be seen as
//     "the operator deleted this" (the 2026-09-06 rewrite of this file got
//     that wrong and would have wiped all of them from main on the first
//     real push).
//  3. Everything goes out as ONE commit via pushFiles() (fetch tree → merge
//     changes + drop deletions → single commit → single ref update), so one
//     push = one deploy, not one deploy per changed file.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { getGithubToken, ghHeaders, ghJson, pushFiles, createPullRequest } from '../lib/github.js';
import {
  SELF_DEV_OWNER, SELF_DEV_REPO, SELF_DEV_BRANCH, SELF_DEV_REPO_FULL_NAME,
  shouldExclude, gitBlobSha,
} from '../lib/selfDevRepo.js';
import { SELF_DEV_ADMIN_MANUAL_SOURCES } from './generateSelfDevManual.js';
import { runVerifySelfDev } from './verifySelfDev.js';
import { SCHEMA_PATH, MIGRATION_RE } from '../lib/selfDevMigrations.js';

const GH_API = 'https://api.github.com';

export default async function handler({ user, body }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });

  const { projectId, force } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id, project_type: 'self_dev' },
  });
  if (!project) throw Object.assign(new Error('Self-dev project not found'), { status: 404 });

  // Gate the push on verification (esbuild syntax + cross-file
  // import/export check over the whole workspace). `force: true` overrides,
  // for the rare case the operator knows the flagged error is a false
  // positive. See verifySelfDev.js.
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

  const token = await getGithubToken(user.id); // throws a friendly "connect GitHub" error if unlinked

  // Remote tree (blobs only). remoteAll = every path; remoteMirrored = just
  // the subset self-dev keeps a local copy of.
  const treeRes = await fetch(`${GH_API}/repos/${SELF_DEV_OWNER}/${SELF_DEV_REPO}/git/trees/${SELF_DEV_BRANCH}?recursive=1`, { headers: ghHeaders(token) });
  if (!treeRes.ok) {
    const err = await ghJson(treeRes);
    throw Object.assign(new Error(`Failed to read ${SELF_DEV_REPO_FULL_NAME} tree: ${err.message || treeRes.status}`), { status: 502 });
  }
  const treeData = await ghJson(treeRes);
  const remoteAll = new Map(); // path -> sha
  for (const e of treeData.tree || []) {
    if (e.type === 'blob') remoteAll.set(e.path, e.sha);
  }
  // If GitHub truncated the tree, our view of the repo is incomplete —
  // computing deletions off it could delete files that are actually still
  // there. Push creates/updates only in that case, never deletions.
  const treeTruncated = !!treeData.truncated;

  const localFiles = await prisma.projectFile.findMany({ where: { project_id: projectId } });
  const localPaths = new Set(localFiles.map((f) => f.path));

  // Changed = created or content-modified vs remote.
  const changed = [];
  for (const f of localFiles) {
    if (shouldExclude(f.path)) continue; // never push an excluded path even if one snuck into the workspace
    const remoteSha = remoteAll.get(f.path);
    if (!remoteSha || remoteSha !== gitBlobSha(f.content)) {
      changed.push({ path: f.path, content: f.content ?? '' });
    }
  }

  // Deleted = a MIRRORED remote path that's no longer in the workspace.
  // Skipped entirely when the remote tree came back truncated (see above).
  const deletePaths = [];
  if (!treeTruncated) {
    for (const remotePath of remoteAll.keys()) {
      if (shouldExclude(remotePath)) continue; // base44/, lockfiles, binaries — not mirrored, not the operator's to delete here
      if (!localPaths.has(remotePath)) deletePaths.push(remotePath);
    }
  }

  if (changed.length === 0 && deletePaths.length === 0) {
    return {
      fileCount: 0, createCount: 0, updateCount: 0, deleteCount: 0, commitUrl: null,
      repoFullName: SELF_DEV_REPO_FULL_NAME, branch: SELF_DEV_BRANCH,
      message: 'No changes to push — workspace already matches production.',
    };
  }

  // A2 — a schema.prisma change must ship its migration in the same push, so
  // applySelfDevMigrations can run it against the DB after this lands. `force`
  // skips the gate (below, via directToMain).
  const schemaChanged = changed.some((c) => c.path === SCHEMA_PATH);
  const hasMigration = changed.some((c) => MIGRATION_RE.test(c.path));
  if (schemaChanged && !hasMigration && !(force || body?.directToMain === true)) {
    return {
      blocked: true,
      reason: 'schema-no-migration',
      repoFullName: SELF_DEV_REPO_FULL_NAME,
      message: 'server/prisma/schema.prisma changed but no server/prisma/selfdev-<slug>.sql migration is included. Ask Morpheus to add the migration file (additive, idempotent DDL) in the same change, then push again — or push with force to skip.',
    };
  }

  const createCount = changed.filter((c) => !remoteAll.has(c.path)).length;
  const updateCount = changed.length - createCount;
  const summary = [
    createCount && `${createCount} new`,
    updateCount && `${updateCount} changed`,
    deletePaths.length && `${deletePaths.length} deleted`,
    treeTruncated && 'deletions skipped (remote tree truncated)',
  ].filter(Boolean).join(', ');

  // Whether this push touches a file the SELF-DEV & ADMIN MANUAL is built
  // from — the manual is regenerated after the change actually lands (here
  // for a direct push, in mergeSelfDevPr.js after the PR merges).
  const touchedManualSource = changed.some((c) => SELF_DEV_ADMIN_MANUAL_SOURCES.includes(c.path))
    || deletePaths.some((p) => SELF_DEV_ADMIN_MANUAL_SOURCES.includes(p));

  // `force` (verify override / hotfix) or an explicit `directToMain` commits
  // straight to main, the original behaviour. The default now lands the
  // change on a throwaway branch and opens a PR — Netlify builds a deploy
  // preview as a second gate over local esbuild, and mergeSelfDevPr.js
  // squash-merges once every check is green. main only ever moves via that
  // merge, so a bad change never reaches production or a deploy.
  const directToMain = force || body?.directToMain === true;

  if (directToMain) {
    const { branch, commitSha } = await pushFiles(
      token, SELF_DEV_REPO_FULL_NAME, changed,
      `Self-dev: ${summary} (via Morpheus)`,
      { isNewRepo: false, deletePaths },
    );
    const commitUrl = `https://github.com/${SELF_DEV_REPO_FULL_NAME}/commit/${commitSha}`;

    await prisma.chatMessage.create({
      data: {
        created_by_id: user.id, project_id: projectId, role: 'morpheus',
        content: `Pushed straight to ${SELF_DEV_REPO_FULL_NAME}@${branch} (${commitSha.substring(0, 7)}): ${summary}. Northflank and Netlify redeploy from here. Welcome to the real world.`,
      },
    });
    await logUsage(user.id, 'self_dev_push', projectId, project.name, {
      mode: 'direct', createCount, updateCount, deleteCount: deletePaths.length, commitSha,
    });
    if (touchedManualSource) {
      try {
        const { runGenerateSelfDevManual } = await import('./generateSelfDevManual.js');
        await runGenerateSelfDevManual(user, 'auto:push');
      } catch (err) {
        console.error('[pushSelfDevToGithub] manual regen failed (push succeeded):', err.message);
      }
    }
    let migrations = null;
    if (schemaChanged || hasMigration) {
      try {
        const { runApplySelfDevMigrations } = await import('./applySelfDevMigrations.js');
        migrations = await runApplySelfDevMigrations(user, { projectId });
      } catch (err) {
        console.error('[pushSelfDevToGithub] migration apply failed (push succeeded):', err.message);
        migrations = { error: err.message };
      }
    }
    return {
      mode: 'direct',
      fileCount: changed.length + deletePaths.length,
      createCount, updateCount, deleteCount: deletePaths.length,
      commitUrl, repoFullName: SELF_DEV_REPO_FULL_NAME, branch, commitSha,
      migrations,
    };
  }

  // ── Default: push to a self-dev/<ts> branch + open a PR ──────────────────
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const prBranch = `self-dev/${ts}`;
  const { commitSha } = await pushFiles(
    token, SELF_DEV_REPO_FULL_NAME, changed,
    `Self-dev: ${summary} (via Morpheus)`,
    { isNewRepo: false, deletePaths, targetBranch: prBranch, baseBranch: SELF_DEV_BRANCH },
  );

  const pr = await createPullRequest(token, SELF_DEV_REPO_FULL_NAME, {
    head: prBranch,
    base: SELF_DEV_BRANCH,
    title: `Self-dev: ${summary}`,
    body: [
      'Automated self-dev change via Morpheus.',
      '',
      `- ${createCount} new, ${updateCount} changed, ${deletePaths.length} deleted`,
      `- Local esbuild verification passed before this PR was opened`,
      '',
      "Morpheus is polling this PR's checks and will squash-merge it automatically once they're green. If a check fails, main is left untouched.",
    ].join('\n'),
  });

  await prisma.chatMessage.create({
    data: {
      created_by_id: user.id, project_id: projectId, role: 'morpheus',
      content: `Opened PR #${pr.number} (\`${prBranch}\`) with ${summary}. Netlify is building a deploy preview now — I'll squash-merge to main automatically once every check passes. ${pr.url}`,
    },
  });

  await logUsage(user.id, 'self_dev_push', projectId, project.name, {
    mode: 'pr', prNumber: pr.number, createCount, updateCount, deleteCount: deletePaths.length, headSha: commitSha,
  });

  return {
    mode: 'pr',
    prNumber: pr.number,
    prUrl: pr.url,
    branch: prBranch,
    headSha: commitSha,
    fileCount: changed.length + deletePaths.length,
    createCount, updateCount, deleteCount: deletePaths.length,
    touchedManualSource,
    hasMigration: schemaChanged || hasMigration,
    repoFullName: SELF_DEV_REPO_FULL_NAME,
  };
}
