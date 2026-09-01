// Self-dev workspace: pushes the current state of the singleton self_dev
// Project's files to the REAL, existing morpheus-self-hosted repo/branch —
// unlike uploadToGithub.js (which always creates or targets a user-named
// repo), this never calls createRepo. It hands the fixed repo straight to
// pushFiles()'s existing-repo merge path (already battle-tested by the
// compile pipeline and other deploy targets in infrastructureComponents.js),
// which reads the real tree, overlays the changed files, and fast-forwards
// main. Northflank/Netlify are already wired to auto-deploy from pushes to
// this repo, so this one call is what "ships" a self-dev change to
// production — no separate deploy API calls needed.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { getGithubToken, pushFiles } from '../lib/github.js';
import { SELF_DEV_REPO_FULL_NAME } from './importSelfDevRepo.js';

export default async function handler({ user, body }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });

  const { projectId, commitMessage } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id, project_type: 'self_dev' } });
  if (!project) throw Object.assign(new Error('Self-dev project not found'), { status: 404 });

  const files = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  if (files.length === 0) throw Object.assign(new Error('No files to push — sync from GitHub first'), { status: 400 });

  const accessToken = await getGithubToken(user.id);
  const filesToPush = files.map((f) => ({ path: f.path, content: f.content }));
  const message = (commitMessage && commitMessage.trim()) || 'Self-dev update via Morpheus';

  // isNewRepo:false — this repo is the real, already-populated production
  // repo, so this always goes through pushFiles' read-existing-tree-and-
  // merge path, never the empty-repo init path.
  const { branch, commitSha } = await pushFiles(accessToken, SELF_DEV_REPO_FULL_NAME, filesToPush, message, { isNewRepo: false });

  await prisma.chatMessage.create({
    data: {
      created_by_id: user.id,
      project_id: projectId,
      role: 'morpheus',
      content: `Pushed ${filesToPush.length} files to ${SELF_DEV_REPO_FULL_NAME}@${branch} (${commitSha.substring(0, 7)}). Northflank and Netlify are watching this repo — production redeploys from here. Welcome to the real world.\n\nNote: this push updates and creates files but does not yet delete files removed locally from the real repo — say the word if you need a file deleted there too.`,
    },
  });

  await logUsage(user.id, 'self_dev_push', projectId, project.name, { fileCount: filesToPush.length, commitSha });

  return {
    repoFullName: SELF_DEV_REPO_FULL_NAME,
    repoUrl: `https://github.com/${SELF_DEV_REPO_FULL_NAME}`,
    commitUrl: `https://github.com/${SELF_DEV_REPO_FULL_NAME}/commit/${commitSha}`,
    branch,
    commitSha,
    fileCount: filesToPush.length,
  };
}
