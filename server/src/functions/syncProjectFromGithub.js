// Pulls a project's linked GitHub repo (Project.github_repo) back into its
// ProjectFile rows — the missing counterpart to compileProject.js's one-way
// push. compileProject always pushes ProjectFile → GitHub before a build,
// trusting the DB as truth; anything that edited the repo directly (a
// manual push, another tool, a human) outside Morpheus's own chat/editor
// gets silently overwritten by the next compile. importSelfDevRepo.js
// already solved exactly this for the one self-dev project (its own "SYNC
// FROM GITHUB" button) — this generalizes that same incremental-sync
// pattern to any project with a linked repo. See KNOWN-HAZARDS.md H9 for
// the sibling incident on the self-dev side of this same architecture gap.
import { prisma } from '../db.js';
import { detectLanguage, logUsage } from '../lib/projectUtils.js';
import { getGithubToken, ghHeaders, ghJson } from '../lib/github.js';
import { shouldExclude, gitBlobSha } from '../lib/selfDevRepo.js';

const GH_API = 'https://api.github.com';

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
  const { projectId } = body;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!project.github_repo) {
    throw Object.assign(new Error('This project has no linked GitHub repo to sync from.'), { status: 400 });
  }

  const accessToken = await getGithubToken(user.id);
  const h = ghHeaders(accessToken);

  const repoRes = await fetch(`${GH_API}/repos/${project.github_repo}`, { headers: h });
  if (!repoRes.ok) {
    const err = await ghJson(repoRes);
    throw Object.assign(new Error(`Failed to reach ${project.github_repo}: ${err.message || repoRes.status}`), { status: 500 });
  }
  const repoInfo = await ghJson(repoRes);
  const branch = repoInfo.default_branch || 'main';

  const treeRes = await fetch(`${GH_API}/repos/${project.github_repo}/git/trees/${branch}?recursive=1`, { headers: h });
  if (!treeRes.ok) {
    const err = await ghJson(treeRes);
    throw Object.assign(new Error(`Failed to fetch ${project.github_repo}@${branch} tree: ${err.message || treeRes.status}`), { status: 500 });
  }
  const treeData = await ghJson(treeRes);
  const blobs = (treeData.tree || []).filter((item) => item.type === 'blob' && !shouldExclude(item.path));

  // Incremental: only fetch a blob whose remote git-sha differs from what we
  // already have — same approach as importSelfDevRepo.js, so a re-sync after
  // a small number of upstream commits stays fast regardless of repo size.
  const localFiles = await prisma.projectFile.findMany({
    where: { project_id: project.id },
    select: { path: true, content: true },
  });
  const localShaByPath = new Map(localFiles.map((f) => [f.path, gitBlobSha(f.content)]));
  const localContentByPath = new Map(localFiles.map((f) => [f.path, f.content]));

  const toFetch = blobs.filter((item) => localShaByPath.get(item.path) !== item.sha);
  const toFetchPaths = new Set(toFetch.map((item) => item.path));

  const fetched = await mapWithConcurrency(toFetch, 20, async (item) => {
    try {
      const blobRes = await fetch(`${GH_API}/repos/${project.github_repo}/git/blobs/${item.sha}`, { headers: h });
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

  const ok = [
    ...fetchedOk,
    ...blobs
      .filter((item) => !toFetchPaths.has(item.path) && localContentByPath.has(item.path))
      .map((item) => ({ path: item.path, content: localContentByPath.get(item.path) })),
  ];

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

  const fetchedCount = fetchedOk.length;
  await prisma.chatMessage.create({
    data: {
      created_by_id: user.id,
      project_id: project.id,
      role: 'morpheus',
      content: `Synced from ${project.github_repo}@${branch}: ${ok.length} file(s) at HEAD (${fetchedCount} fetched, ${ok.length - fetchedCount} already current)${failed ? `, ${failed} failed` : ''}${staleIds.length ? `, ${staleIds.length} removed locally (deleted upstream)` : ''}.`,
    },
  });

  await logUsage(user.id, 'project_sync_from_github', project.id, project.name, {
    repo: project.github_repo, fileCount: ok.length, fetched: fetchedCount, skipped: failed, removed: staleIds.length,
  });

  return {
    projectId: project.id,
    repoFullName: project.github_repo,
    branch,
    fileCount: ok.length,
    fetched: fetchedCount,
    skipped: failed,
    removed: staleIds.length,
  };
}
