// Self-dev "PUSH TO PRODUCTION": pushes the current state of the singleton
// self_dev workspace to the REAL morpheus-self-hosted repo/branch. This is
// the actual deploy trigger — Northflank + Netlify both auto-build from a
// push to that branch, no PR step.
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
import { getGithubToken, ghHeaders, ghJson, pushFiles } from '../lib/github.js';
import {
  SELF_DEV_OWNER, SELF_DEV_REPO, SELF_DEV_BRANCH, SELF_DEV_REPO_FULL_NAME,
  shouldExclude,
} from '../lib/selfDevRepo.js';
import { runGenerateSelfDevManual, SELF_DEV_ADMIN_MANUAL_SOURCES } from './generateSelfDevManual.js';
import crypto from 'node:crypto';

const GH_API = 'https://api.github.com';

// git's own blob object id: sha1("blob <bytelen>\0" + bytes). Lets us
// compare a local file against the remote tree entry's sha without fetching
// the remote blob content.
function gitBlobSha(content) {
  const buf = Buffer.from(content ?? '', 'utf8');
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

export default async function handler({ user, body }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });

  const { projectId } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id, project_type: 'self_dev' },
  });
  if (!project) throw Object.assign(new Error('Self-dev project not found'), { status: 404 });

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
  const deletePaths = [];
  for (const remotePath of remoteAll.keys()) {
    if (shouldExclude(remotePath)) continue; // base44/, lockfiles, binaries — not mirrored, not the operator's to delete here
    if (!localPaths.has(remotePath)) deletePaths.push(remotePath);
  }

  if (changed.length === 0 && deletePaths.length === 0) {
    return {
      fileCount: 0, createCount: 0, updateCount: 0, deleteCount: 0, commitUrl: null,
      repoFullName: SELF_DEV_REPO_FULL_NAME, branch: SELF_DEV_BRANCH,
      message: 'No changes to push — workspace already matches production.',
    };
  }

  const createCount = changed.filter((c) => !remoteAll.has(c.path)).length;
  const updateCount = changed.length - createCount;
  const summary = [
    createCount && `${createCount} new`,
    updateCount && `${updateCount} changed`,
    deletePaths.length && `${deletePaths.length} deleted`,
  ].filter(Boolean).join(', ');

  const { branch, commitSha } = await pushFiles(
    token,
    SELF_DEV_REPO_FULL_NAME,
    changed,
    `Self-dev: ${summary} (via Morpheus)`,
    { isNewRepo: false, deletePaths },
  );

  const commitUrl = `https://github.com/${SELF_DEV_REPO_FULL_NAME}/commit/${commitSha}`;

  await prisma.chatMessage.create({
    data: {
      created_by_id: user.id,
      project_id: projectId,
      role: 'morpheus',
      content: `Pushed to ${SELF_DEV_REPO_FULL_NAME}@${branch} (${commitSha.substring(0, 7)}): ${summary}. Northflank and Netlify are watching this branch — production redeploys from here. Welcome to the real world.`,
    },
  });

  await logUsage(user.id, 'self_dev_push', projectId, project.name, {
    createCount, updateCount, deleteCount: deletePaths.length, commitSha,
  });

  // Auto-refresh the SELF-DEV & ADMIN MANUAL when this push touched a file it
  // is built from — best-effort, never fails the push (which already
  // succeeded above).
  const touchedManualSource = changed.some((c) => SELF_DEV_ADMIN_MANUAL_SOURCES.includes(c.path))
    || deletePaths.some((p) => SELF_DEV_ADMIN_MANUAL_SOURCES.includes(p));
  if (touchedManualSource) {
    try {
      await runGenerateSelfDevManual(user, 'auto:push');
    } catch (err) {
      console.error('[pushSelfDevToGithub] auto-regenerating the self-dev/admin manual failed (push itself succeeded):', err.message);
    }
  }

  return {
    fileCount: changed.length + deletePaths.length,
    createCount,
    updateCount,
    deleteCount: deletePaths.length,
    commitUrl,
    repoFullName: SELF_DEV_REPO_FULL_NAME,
    branch,
    commitSha,
  };
}
