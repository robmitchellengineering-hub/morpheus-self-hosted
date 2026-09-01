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

const GH_API = 'https://api.github.com';

// The real, live Morpheus production repo — not user-configurable. Self-dev
// only ever reads from and pushes to this one repo/branch.
const SELF_DEV_OWNER = 'robmitchellengineering-hub';
const SELF_DEV_REPO = 'morpheus-self-hosted';
const SELF_DEV_BRANCH = 'main';
export const SELF_DEV_REPO_FULL_NAME = `${SELF_DEV_OWNER}/${SELF_DEV_REPO}`;

function shouldSkip(path) {
  const lower = path.toLowerCase();
  if (lower.includes('node_modules/') || lower.includes('.git/')) return true;
  if (lower.includes('/dist/') || lower.includes('/.next/') || lower.includes('/coverage/')) return true;
  // base44/ — confirmed dead weight, not the app itself: README.md says it's
  // "the original app's entity/function definitions, kept for reference; not
  // used at runtime by this stack." ~75 files (2026-09-02: about a fifth of
  // the whole repo) that never need editing, sorting alphabetically ahead of
  // src/ and server/ in the flat file list — made genuinely-relevant files
  // (e.g. src/pages/Landing.jsx) hard to find by scrolling. Safe to exclude
  // from import: pushSelfDevToGithub.js only ever overlays/creates files, it
  // never deletes anything upstream that's missing locally, so base44/ stays
  // exactly as-is in the real repo regardless of this exclusion.
  if (/^base44\//.test(lower)) return true;
  // Lock files: huge, machine-generated, never something Rob or the AI needs
  // to read/edit in a chat context.
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(lower)) return true;
  const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.zip', '.jar', '.class', '.so', '.dll', '.exe', '.bin', '.dat', '.pdf'];
  return binaryExts.some((ext) => lower.endsWith(ext));
}

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

  const fetched = await mapWithConcurrency(blobs, 6, async (item) => {
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
