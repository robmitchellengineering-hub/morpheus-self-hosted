// Self-dev workspace: (re)syncs Morpheus's own live source repo into a
// singleton, admin-only Project (project_type: 'self_dev') so Rob can use
// Morpheus's normal chat/editor/preview workspace to develop Morpheus itself.
//
// Deliberately separate from importFromGithub.js rather than reusing it:
// that function takes an arbitrary user-supplied repo, creates a brand-new
// Project every call, and caps at 150 files. This one always targets the
// same fixed real repo/branch, upserts into ONE persistent project (so chat
// history and file state survive across sessions), and has no file cap
// (Morpheus's own codebase is larger than 150 files) — safe to call
// repeatedly as a "pull latest" action.
import { prisma } from '../db.js';
import { detectLanguage, logUsage } from '../lib/projectUtils.js';
import { getGithubToken, ghHeaders, ghJson } from '../lib/github.js';
import {
  SELF_DEV_OWNER, SELF_DEV_REPO, SELF_DEV_BRANCH, SELF_DEV_REPO_FULL_NAME,
  shouldExclude as shouldSkip, gitBlobSha,
} from '../lib/selfDevRepo.js';
import { recordSyncedCommitSafely } from '../lib/selfDevDrift.js';

const GH_API = 'https://api.github.com';

export { SELF_DEV_REPO_FULL_NAME };

// Fetch blob contents with limited concurrency — sequential would be slow for
// a 150+ file repo, but unbounded parallelism risks GitHub's secondary rate
// limiter (the same one github.js's createBlob/createRepo already retry
// around on the write side).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export default async function handler({ user, body }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });

  const accessToken = await getGithubToken(user.id);
  const h = ghHeaders(accessToken);

  const treeRes = await fetch(`${GH_API}/repos/${SELF_DEV_OWNER}/${SELF_DEV_REPO}/git/trees/${SELF_DEV_BRANCH}?recursive=1`, { headers: h });
  if (!treeRes.ok) {
    const err = await ghJson(treeRes);
    throw Object.assign(new Error(`Failed to fetch morpheus-self-hosted tree: ${err.message || treeRes.status}`), { status: 500 });
  }
  const treeData = await ghJson(treeRes);

  // The commit SHA this sync represents. The H9 drift guard compares it against
  // the branch HEAD at push time, so a stale mirror is detectable. Read from the
  // branch REF, not the tree — treeData.sha is a tree sha, not a commit sha.
  // Non-fatal on failure: the guard then falls back to its deletion-shape check.
  let headCommit = null;
  try {
    const refRes = await fetch(`${GH_API}/repos/${SELF_DEV_OWNER}/${SELF_DEV_REPO}/git/ref/heads/${SELF_DEV_BRANCH}`, { headers: h });
    if (refRes.ok) headCommit = (await ghJson(refRes)).object?.sha || null;
  } catch {
    headCommit = null;
  }
  if (treeData.truncated) {
    console.log(`importSelfDevRepo: GitHub truncated the recursive tree for ${SELF_DEV_REPO_FULL_NAME} — repo may be larger than GitHub's non-paginated tree limit.`);
  }

  const blobs = (treeData.tree || []).filter((item) => item.type === 'blob' && !shouldSkip(item.path));

  // Find or create the singleton self-dev project for this admin.
  let project = await prisma.project.findFirst({ where: { created_by_id: user.id, project_type: 'self_dev' } });
  if (!project) {
    project = await prisma.project.create({
      data: {
        created_by_id: user.id,
        name: 'Morpheus Self-Dev',
        description: `Live self-development workspace — reads from and pushes to the real ${SELF_DEV_REPO_FULL_NAME}@${SELF_DEV_BRANCH}.`,
        status: 'ready',
        compile_target: 'web-app',
        project_type: 'self_dev',
      },
    });
  }

  // Incremental sync: only fetch a blob whose remote git-sha differs from the
  // content we already have. A first sync fetches everything (~470 blobs); a
  // re-sync after a few upstream commits fetches a handful, turning a ~2.5min
  // spinner into a few seconds. (2026-09-09 — Rob: "sync is slow".)
  const localFiles = await prisma.projectFile.findMany({
    where: { project_id: project.id },
    select: { path: true, content: true },
  });
  const localShaByPath = new Map(localFiles.map((f) => [f.path, gitBlobSha(f.content)]));
  const localContentByPath = new Map(localFiles.map((f) => [f.path, f.content]));

  const toFetch = blobs.filter((item) => localShaByPath.get(item.path) !== item.sha);
  const toFetchPaths = new Set(toFetch.map((item) => item.path));

  // Concurrency 20: well under GitHub's secondary-rate-limit threshold for
  // reads (which mostly targets write bursts). Read rate limit is 5000/hr.
  const fetched = await mapWithConcurrency(toFetch, 20, async (item) => {
    try {
      const blobRes = await fetch(`${GH_API}/repos/${SELF_DEV_OWNER}/${SELF_DEV_REPO}/git/blobs/${item.sha}`, { headers: h });
      if (!blobRes.ok) return null;
      const blob = await ghJson(blobRes);
      const content = blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64').toString('utf8') : (blob.content || '');
      return { path: item.path, content };
    } catch {
      return null;
    }
  });

  const fetchedOk = fetched.filter(Boolean);
  const failed = fetched.length - fetchedOk.length;

  // The full HEAD file set = freshly-fetched + the ones we skipped because
  // they were already current.
  const ok = [
    ...fetchedOk,
    ...blobs
      .filter((item) => !toFetchPaths.has(item.path) && localContentByPath.has(item.path))
      .map((item) => ({ path: item.path, content: localContentByPath.get(item.path) })),
  ];
  const skipped = failed;

  // Upsert only what changed; delete any local rows for paths that no longer
  // exist upstream — keeps the workspace a true mirror of HEAD.
  for (const f of fetchedOk) {
    await prisma.projectFile.upsert({
      where: { project_id_path: { project_id: project.id, path: f.path } },
      update: { content: f.content, language: detectLanguage(f.path) },
      create: { created_by_id: user.id, project_id: project.id, path: f.path, content: f.content, language: detectLanguage(f.path) },
    });
  }
  const keepPaths = new Set(ok.map((f) => f.path));
  const existing = await prisma.projectFile.findMany({ where: { project_id: project.id }, select: { id: true, path: true } });
  const staleIds = existing.filter((f) => !keepPaths.has(f.path)).map((f) => f.id);
  if (staleIds.length > 0) {
    await prisma.projectFile.deleteMany({ where: { id: { in: staleIds } } });
  }

  // Record the sync point. This is what turns "is my workspace stale?" from an
  // assumption into a decidable question at push time (KNOWN-HAZARDS.md H9).
  // Tolerates the column shipping ahead of its migration, exactly as
  // self_dev_decisions does — the guard degrades, the sync still succeeds.
  if (headCommit) {
    // Best-effort: the sync itself already succeeded, so failing to write the
    // marker must not fail the sync.
    await recordSyncedCommitSafely(
      () => prisma.project.update({ where: { id: project.id }, data: { synced_commit: headCommit } }),
      { context: 'importSelfDevRepo' },
    );
  }

  const fetchedCount = fetchedOk.length;
  await prisma.chatMessage.create({
    data: {
      created_by_id: user.id,
      project_id: project.id,
      role: 'morpheus',
      content: `Synced from ${SELF_DEV_REPO_FULL_NAME}@${SELF_DEV_BRANCH}: ${ok.length} files at HEAD (${fetchedCount} fetched, ${ok.length - fetchedCount} already current)${skipped ? `, ${skipped} failed` : ''}${staleIds.length ? `, ${staleIds.length} removed locally (deleted upstream)` : ''}. This is the real, live Morpheus codebase — free your mind, but mind what you overwrite.`,
    },
  });

  await logUsage(user.id, 'self_dev_sync', project.id, project.name, { fileCount: ok.length, fetched: fetchedCount, skipped, removed: staleIds.length });

  return {
    projectId: project.id,
    fileCount: ok.length,
    fetched: fetchedCount,
    skipped,
    removed: staleIds.length,
    repoFullName: SELF_DEV_REPO_FULL_NAME,
    branch: SELF_DEV_BRANCH,
  };
}
