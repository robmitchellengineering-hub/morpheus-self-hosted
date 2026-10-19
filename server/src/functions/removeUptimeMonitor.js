// Delete the uptime-check workflow from the connected repo — stops the
// scheduled monitoring. Requires confirm:true.
import { prisma } from '../db.js';
import { getGithubToken, getFileContent, deleteFile } from '../lib/github.js';
import { UPTIME_PATH } from '../lib/uptimeWorkflow.js';

const GH_API = 'https://api.github.com';

export default async function handler({ user, body }) {
  const { projectId, confirm } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (confirm !== true) throw Object.assign(new Error('confirm:true is required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!project.github_repo || !project.github_repo.includes('/')) {
    throw Object.assign(new Error('This project isn’t connected to a GitHub repo.'), { status: 400 });
  }

  const [owner, repo] = project.github_repo.split('/');
  const token = await getGithubToken(user.id, { projectId });
  const { default_branch } = await (await fetch(`${GH_API}/repos/${owner}/${repo}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })).json();
  const branch = default_branch || 'main';

  const existing = await getFileContent(owner, repo, UPTIME_PATH, branch, token).catch(() => null);
  if (!existing) return { removed: false, reason: 'not set up' };

  await deleteFile(owner, repo, UPTIME_PATH, branch, existing.sha, token, 'Remove uptime monitoring');
  return { removed: true, path: UPTIME_PATH, branch, repo: project.github_repo };
}
