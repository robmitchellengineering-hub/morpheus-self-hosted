// Roll the live site back to an earlier commit on the connected repo. Done
// as one forward commit that restores every file to the chosen state — no
// history rewrite, no force-push. The connected host redeploys on the push;
// nothing about the deploy touches Morpheus.
//
// Requires an explicit confirm:true — this changes what's live.
import { prisma } from '../db.js';
import { getGithubToken, rollbackToCommit } from '../lib/github.js';

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export default async function handler({ user, body }) {
  const { projectId, targetSha, confirm } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!targetSha || !SHA_RE.test(String(targetSha))) throw Object.assign(new Error('a valid target commit sha is required'), { status: 400 });
  if (confirm !== true) throw Object.assign(new Error('confirm:true is required — this changes the live site'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!project.github_repo || !project.github_repo.includes('/')) {
    throw Object.assign(new Error('This project isn’t connected to a GitHub repo — export it first.'), { status: 400 });
  }

  const token = await getGithubToken(user.id, { projectId });
  const result = await rollbackToCommit(token, project.github_repo, String(targetSha));
  return { ...result, repo: project.github_repo };
}
