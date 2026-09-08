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
  shouldExclude as shouldSkip,
} from '../lib/selfDevRepo.js';

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

  // Concurrency 20: a full sync is ~470 blob GETs. At 6 that's ~90s of the
  // operator watching a spinner; at 20 it's ~10-15s and still well under
  // GitHub's secondary-rate-limit threshold for reads (which mostly targets
  // write bursts). Read rate limit is 5000/hr — one sync is a rounding error.
  const fetched = await mapWithConcurrency(blobs, 20, async (item) => {
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

  const ok = fetched.filter(Boolean);
  const skipped = fetched.length - ok.length;

  // Upsert each fetched file, then delete any local rows for paths that no
  // longer exist upstream — keeps the workspace a true mirror of HEAD.
  for (const f of ok) {
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

  await prisma.chatMessage.create({
    data: {
      created_by_id: user.id,
      project_id: project.id,
      role: 'morpheus',
      content: `Synced from ${SELF_DEV_REPO_FULL_NAME}@${SELF_DEV_BRANCH}: ${ok.length} files pulled${skipped ? `, ${skipped} skipped` : ''}${staleIds.length ? `, ${staleIds.length} removed locally (deleted upstream)` : ''}. This is the real, live Morpheus codebase — free your mind, but mind what you overwrite.`,
    },
  });

  await logUsage(user.id, 'self_dev_sync', project.id, project.name, { fileCount: ok.length, skipped, removed: staleIds.length });

  return {
    projectId: project.id,
    fileCount: ok.length,
    skipped,
    removed: staleIds.length,
    repoFullName: SELF_DEV_REPO_FULL_NAME,
    branch: SELF_DEV_BRANCH,
  };
}
