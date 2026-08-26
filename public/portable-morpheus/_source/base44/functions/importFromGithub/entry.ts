import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { detectLanguage, logUsage } from '../../shared/projectUtils.ts';
import { getAppUserGithubToken } from '../../shared/githubConnection.ts';
import { ghHeaders, ghJson } from '../../shared/githubPush.ts';

const GH_API = 'https://api.github.com';

// Skip binary-looking files and node_modules/.git noise
function shouldSkip(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.includes('node_modules/') || lower.includes('.git/')) return true;
  if (lower.includes('/dist/') || lower.includes('/build/') && !lower.endsWith('.gradle')) return true;
  const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.zip', '.jar', '.class', '.so', '.dll', '.exe', '.bin', '.dat', '.pdf'];
  return binaryExts.some(ext => lower.endsWith(ext));
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { repoInput, compileTarget } = body;
    if (!repoInput) return Response.json({ error: 'repoInput required' }, { status: 400 });

    let accessToken;
    try {
      accessToken = await getAppUserGithubToken(base44);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    const h = ghHeaders(accessToken);

    // Parse owner/repo from input — accept "owner/repo", full URL, or "https://github.com/owner/repo.git"
    let owner: string, repo: string;
    const cleaned = repoInput.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    const parts = cleaned.split('/');
    if (parts.length >= 2) {
      owner = parts[parts.length - 2];
      repo = parts[parts.length - 1];
    } else {
      return Response.json({ error: 'Invalid repo format. Use owner/repo or a GitHub URL.' }, { status: 400 });
    }

    // Get repo info
    const repoRes = await fetch(`${GH_API}/repos/${owner}/${repo}`, { headers: h });
    if (!repoRes.ok) {
      const err = await ghJson(repoRes);
      return Response.json({ error: `Repository not found: ${err.message || repoRes.status}` }, { status: 404 });
    }
    const repoInfo = await ghJson(repoRes);
    const branch = repoInfo.default_branch || 'main';

    // Get file tree recursively
    const treeRes = await fetch(`${GH_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { headers: h });
    if (!treeRes.ok) return Response.json({ error: 'Failed to fetch repository tree' }, { status: 500 });
    const treeData = await ghJson(treeRes);

    const blobs = (treeData.tree || []).filter((item: any) => item.type === 'blob' && !shouldSkip(item.path));
    const MAX_FILES = 150;
    const toFetch = blobs.slice(0, MAX_FILES);
    const truncated = blobs.length > MAX_FILES;

    // Create the project first
    const project = await base44.entities.Project.create({
      name: repoInfo.name || repo,
      description: repoInfo.description || `Imported from ${owner}/${repo}`,
      status: 'ready',
      compile_target: compileTarget || 'source'
    });

    // Fetch file contents and build ProjectFile records
    const fileRecords: any[] = [];
    let fetched = 0;
    let skipped = 0;

    for (const item of toFetch) {
      try {
        const blobRes = await fetch(`${GH_API}/repos/${owner}/${repo}/git/blobs/${item.sha}`, { headers: h });
        if (!blobRes.ok) { skipped++; continue; }
        const blob = await ghJson(blobRes);
        // GitHub returns content base64-encoded; decode it
        let content = '';
        if (blob.encoding === 'base64') {
          // Deno has atob
          content = atob(blob.content);
        } else {
          content = blob.content || '';
        }
        fileRecords.push({
          project_id: project.id,
          path: item.path,
          content,
          language: detectLanguage(item.path)
        });
        fetched++;
      } catch {
        skipped++;
      }
    }

    if (fileRecords.length > 0) {
      await base44.entities.ProjectFile.bulkCreate(fileRecords);
    }

    // Log to chat
    await base44.entities.ChatMessage.create({
      project_id: project.id,
      role: 'morpheus',
      content: `Construct imported from ${owner}/${repo} (${branch}). ${fetched} files jacked in${truncated ? ` (truncated — repo had ${blobs.length} files, max ${MAX_FILES})` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}. The code is yours. What shall we build with it?`
    });

    await logUsage(base44, 'github_import', project.id, project.name, { repo: `${owner}/${repo}`, fileCount: fetched });
    return Response.json({
      projectId: project.id,
      projectName: project.name,
      fileCount: fetched,
      skipped,
      truncated,
      totalFiles: blobs.length
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}