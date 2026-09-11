// List the project's editable content — every content/*.json file in the
// connected repo, parsed, with its blob sha for a safe write-back.
import { prisma } from '../db.js';
import { getGithubToken, fetchRemoteTree, getFileContent } from '../lib/github.js';
import { CONTENT_DIR, isContentPath, contentName } from '../lib/projectCms.js';

const GH_API = 'https://api.github.com';

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  if (!project.github_repo || !project.github_repo.includes('/')) {
    return { connected: false, files: [], repo: null, branch: null };
  }

  const [owner, repo] = project.github_repo.split('/');
  const token = await getGithubToken(user.id, { projectId });

  const { default_branch } = await (await fetch(`${GH_API}/repos/${owner}/${repo}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })).json();
  const branch = default_branch || 'main';

  const tree = await fetchRemoteTree(owner, repo, branch, token).catch(() => []);
  const contentPaths = tree
    .map((e) => e.path)
    .filter((p) => p.startsWith(CONTENT_DIR) && isContentPath(p))
    .sort();

  const files = [];
  for (const path of contentPaths.slice(0, 40)) {
    const file = await getFileContent(owner, repo, path, branch, token).catch(() => null);
    if (!file) continue;
    let json = null;
    let parseError = null;
    try { json = JSON.parse(file.content); } catch (e) { parseError = e.message; }
    files.push({ path, name: contentName(path), json, raw: file.content, sha: file.sha, parseError });
  }

  return { connected: true, repo: project.github_repo, branch, files };
}
