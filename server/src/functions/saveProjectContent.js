// Commit an edited content/*.json file back to the connected repo. The host
// redeploys on the push. Morpheus stores nothing — the value goes straight
// from the panel to the operator's repo.
import { prisma } from '../db.js';
import { getGithubToken, getFileContent, createOrUpdateFile } from '../lib/github.js';
import { isContentPath, contentName } from '../lib/projectCms.js';

const GH_API = 'https://api.github.com';

export default async function handler({ user, body }) {
  const { projectId, path, json, sha } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!isContentPath(path)) throw Object.assign(new Error('path must be a .json file under content/'), { status: 400 });
  if (typeof json === 'undefined') throw Object.assign(new Error('json body required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!project.github_repo || !project.github_repo.includes('/')) {
    throw Object.assign(new Error('This project isn’t connected to a GitHub repo — export it first.'), { status: 400 });
  }

  const [owner, repo] = project.github_repo.split('/');
  const token = await getGithubToken(user.id, { projectId });
  const { default_branch } = await (await fetch(`${GH_API}/repos/${owner}/${repo}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })).json();
  const branch = default_branch || 'main';

  // Serialise deterministically so diffs stay small; reject anything that
  // isn't plain JSON-serialisable.
  let content;
  try { content = JSON.stringify(json, null, 2) + '\n'; } catch { throw Object.assign(new Error('content is not valid JSON'), { status: 400 }); }
  if (content.length > 512 * 1024) throw Object.assign(new Error('content file is too large (512KB limit)'), { status: 400 });

  // Resolve the current sha (caller may pass a stale one, or none for a new file).
  let writeSha = sha;
  const existing = await getFileContent(owner, repo, path, branch, token).catch(() => null);
  if (existing) {
    if (sha && sha !== existing.sha) {
      throw Object.assign(new Error('This file changed since you loaded it — reopen the panel and re-apply your edit.'), { status: 409 });
    }
    writeSha = existing.sha;
  } else {
    writeSha = undefined; // creating
  }

  const result = await createOrUpdateFile(owner, repo, path, content, branch, token, `Edit ${contentName(path)} content`, writeSha);
  return { path, sha: result.content?.sha || null, commitSha: result.commit?.sha || null, branch, repo: project.github_repo };
}
