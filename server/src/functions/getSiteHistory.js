// Recent commits on the project's connected repo — the rollback picker in
// the DOMAIN panel. The repo is the site's source of truth; the connected
// host redeploys on push, so this history IS the deploy history.
import { prisma } from '../db.js';
import { getGithubToken, listRecentCommits } from '../lib/github.js';

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  if (!project.github_repo || !project.github_repo.includes('/')) {
    return { connected: false, commits: [], branch: null, headSha: null };
  }

  const token = await getGithubToken(user.id);
  const { branch, headSha, commits } = await listRecentCommits(token, project.github_repo, { perPage: 20 });
  return { connected: true, repo: project.github_repo, branch, headSha, commits };
}
