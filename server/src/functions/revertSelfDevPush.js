// REVERT LAST PUSH — instant production rollback for self-dev (Command Deck:
// self-dev replaces the dev loop, Tier 1 #3). Points main at the tree from
// just before the given commit, as one new commit. Northflank + Netlify
// redeploy from it like any other push, so this un-breaks production
// without the AI in the loop.
//
// Only reverts a commit that is still the branch head (i.e. nothing else
// pushed since) — see github.js's revertCommit.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { getGithubToken, revertCommit } from '../lib/github.js';
import { SELF_DEV_REPO_FULL_NAME } from '../lib/selfDevRepo.js';

export default async function handler({ user, body }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });

  const { commitSha } = body || {};
  if (!commitSha || !/^[0-9a-f]{7,40}$/i.test(commitSha)) {
    throw Object.assign(new Error('A commitSha to revert is required'), { status: 400 });
  }

  const project = await prisma.project.findFirst({
    where: { created_by_id: user.id, project_type: 'self_dev' },
  });

  const token = await getGithubToken(user.id);
  const { commitSha: revertSha, revertedToSha, branch } = await revertCommit(token, SELF_DEV_REPO_FULL_NAME, commitSha);

  const commitUrl = `https://github.com/${SELF_DEV_REPO_FULL_NAME}/commit/${revertSha}`;

  if (project) {
    await prisma.chatMessage.create({
      data: {
        created_by_id: user.id,
        project_id: project.id,
        role: 'morpheus',
        content: `Reverted ${commitSha.slice(0, 7)} on ${SELF_DEV_REPO_FULL_NAME}@${branch}. Production is rolling back to ${revertedToSha.slice(0, 7)} — the state before that push. Sync from GitHub to pull the rolled-back files into the workspace.`,
      },
    });
    await logUsage(user.id, 'self_dev_revert', project.id, project.name, { reverted: commitSha, revertSha, revertedToSha });
  }

  return { commitSha: revertSha, revertedToSha, branch, commitUrl, repoFullName: SELF_DEV_REPO_FULL_NAME };
}
