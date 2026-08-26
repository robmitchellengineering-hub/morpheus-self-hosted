import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { logUsage } from '../../shared/projectUtils.ts';
import { getAppUserGithubToken } from '../../shared/githubConnection.ts';
import { createRepo, pushFiles } from '../../shared/githubPush.ts';
import { aggregateBuildLogs, generateBuildLogMarkdown } from '../../shared/buildLogs.ts';

// Uploads project files + BUILD_LOG.md to a new or existing GitHub repo.
// Uses the shared pushFiles helper (has retry logic for tree creation and
// proper error handling) instead of reimplementing the Git Data API flow.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId, repoName, isPrivate } = body;
    if (!projectId || !repoName) return Response.json({ error: 'projectId and repoName required' }, { status: 400 });

    let accessToken;
    try {
      accessToken = await getAppUserGithubToken(base44);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }

    // Create repo (or use existing if name taken)
    const repo = await createRepo(accessToken, repoName, !!isPrivate);
    if (!repo || !repo.full_name) return Response.json({ error: 'Failed to create or access repository' }, { status: 500 });

    // Get project files and generate build log
    const files = await base44.entities.ProjectFile.filter({ project_id: projectId });
    if (files.length === 0) return Response.json({ error: 'No files to upload' }, { status: 400 });

    const project = await base44.entities.Project.get(projectId);
    const buildLogs = await aggregateBuildLogs(base44, projectId);
    const buildLogMd = generateBuildLogMarkdown(project.name, buildLogs);

    // Push all project files + BUILD_LOG.md using the shared helper
    const allFiles = [
      ...files.map(f => ({ path: f.path, content: f.content })),
      { path: 'BUILD_LOG.md', content: buildLogMd }
    ];
    await pushFiles(accessToken, repo.full_name, allFiles, 'Upload from Morpheus');

    await logUsage(base44, 'github_upload', projectId, project.name, { repo: repo.full_name, fileCount: files.length + 1 });
    return Response.json({ repoUrl: repo.html_url, fileCount: files.length });
  } catch (error) {
    console.error('Upload to GitHub error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}