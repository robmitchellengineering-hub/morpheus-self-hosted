// Ported from base44/functions/uploadToGithub/entry.ts.
// Uploads project files + BUILD_LOG.md to a new or existing GitHub repo.
// Uses the shared pushFiles helper (has retry logic for tree creation and
// proper error handling) instead of reimplementing the Git Data API flow.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { getGithubToken, createRepo, pushFiles } from '../lib/github.js';
import { aggregateBuildLogs, generateBuildLogMarkdown } from '../lib/buildLogs.js';

export default async function handler({ user, body }) {
  const { projectId, repoName, isPrivate } = body;
  if (!projectId || !repoName) {
    throw Object.assign(new Error('projectId and repoName required'), { status: 400 });
  }

  // getGithubToken already throws a 400 "GitHub not connected" error if the
  // user hasn't linked their account — matches the original's try/catch.
  const accessToken = await getGithubToken(user.id);

  // Create repo (or use existing if name taken)
  const repo = await createRepo(accessToken, repoName, !!isPrivate);
  if (!repo || !repo.full_name) {
    throw Object.assign(new Error('Failed to create or access repository'), { status: 500 });
  }

  // Get project files and generate build log
  const files = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  if (files.length === 0) {
    throw Object.assign(new Error('No files to upload'), { status: 400 });
  }

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const buildLogs = await aggregateBuildLogs(user.id, projectId);
  const buildLogMd = generateBuildLogMarkdown(project.name, buildLogs);

  // Push all project files + BUILD_LOG.md using the shared helper
  const allFiles = [
    ...files.map((f) => ({ path: f.path, content: f.content })),
    { path: 'BUILD_LOG.md', content: buildLogMd },
  ];
  await pushFiles(accessToken, repo.full_name, allFiles, 'Upload from Morpheus');

  await logUsage(user.id, 'github_upload', projectId, project.name, { repo: repo.full_name, fileCount: files.length + 1 });
  return { repoUrl: repo.html_url, fileCount: files.length };
}
