// REVERT LAST PUSH — instant production rollback for self-dev (Command Deck:
// self-dev replaces the dev loop, Tier 1 #3). Points main at the tree from
// just before the given commit, as one new commit. Northflank + Netlify
// redeploy from it like any other push, so this un-breaks production
// without the AI in the loop.
//
// Only reverts a commit that is still the branch head (i.e. nothing else
// pushed since) — see github.js's revertCommit.
import { prisma } from '../db.js';
import { logUsage, detectLanguage } from '../lib/projectUtils.js';
import { getGithubToken, revertCommit } from '../lib/github.js';
import { SELF_DEV_REPO_FULL_NAME } from '../lib/selfDevRepo.js';

// Drop a dated, unfilled incident section into the workspace's KNOWN-HAZARDS.md
// so the next self-dev turn's planner/reviewer see that this push broke prod —
// the AI is asked (in the revert chat note) to fill in the root cause as part
// of its fix. Best-effort: a revert must never fail because of this.
async function appendHazardStub(projectId, userId, badCommitSha) {
  const path = 'KNOWN-HAZARDS.md';
  const existing = await prisma.projectFile.findUnique({
    where: { project_id_path: { project_id: projectId, path } },
  });
  const date = new Date().toISOString().slice(0, 10);
  const stub = `\n\n## Incident ${date} — reverted ${badCommitSha.slice(0, 7)}\n`
    + `A push was reverted from production on ${date}. **Root cause: _(fill this in as part of the fix — what broke, and the rule that stops it recurring)_.**\n`;
  const base = existing?.content ?? '# KNOWN HAZARDS\n';
  await prisma.projectFile.upsert({
    where: { project_id_path: { project_id: projectId, path } },
    update: { content: base + stub },
    create: { created_by_id: userId, project_id: projectId, path, content: base + stub, language: detectLanguage(path) },
  });
}

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
        content: `Reverted ${commitSha.slice(0, 7)} on ${SELF_DEV_REPO_FULL_NAME}@${branch}. Production is rolling back to ${revertedToSha.slice(0, 7)} — the state before that push. Sync from GitHub to pull the rolled-back files into the workspace, and record the root cause in KNOWN-HAZARDS.md so it doesn't recur.`,
      },
    });
    await logUsage(user.id, 'self_dev_revert', project.id, project.name, { reverted: commitSha, revertSha, revertedToSha });
    await appendHazardStub(project.id, user.id, commitSha).catch((e) =>
      console.error('[revertSelfDevPush] could not append hazard stub (revert succeeded):', e.message));
  }

  return { commitSha: revertSha, revertedToSha, branch, commitUrl, repoFullName: SELF_DEV_REPO_FULL_NAME };
}
