// Commit (or update) the uptime-check GitHub Action into the connected
// repo. The check then runs on GitHub's schedule against the operator's
// production URL — Morpheus is not involved after this write.
import { prisma } from '../db.js';
import { getGithubToken, getFileContent, createOrUpdateFile } from '../lib/github.js';
import { SITE_PATH, normalizeSite } from '../lib/projectSite.js';
import { UPTIME_PATH, UPTIME_INTERVALS, uptimeWorkflowYaml, cronFor } from '../lib/uptimeWorkflow.js';

const GH_API = 'https://api.github.com';

export default async function handler({ user, body }) {
  const { projectId, intervalMinutes, url: overrideUrl } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  const minutes = UPTIME_INTERVALS.includes(Number(intervalMinutes)) ? Number(intervalMinutes) : 15;

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!project.github_repo || !project.github_repo.includes('/')) {
    throw Object.assign(new Error('This project isn’t connected to a GitHub repo — export it first.'), { status: 400 });
  }

  // Resolve the URL to watch: an explicit override, else the site.json domain.
  let url = '';
  if (overrideUrl && /^https?:\/\/[^\s]+$/i.test(overrideUrl)) {
    url = overrideUrl.replace(/^http:/, 'https:');
  } else {
    const row = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: SITE_PATH } });
    if (row?.content) {
      try {
        const s = normalizeSite(JSON.parse(row.content));
        if (s.domain) url = `https://${s.canonical === 'www' ? 'www.' : ''}${s.domain}`;
      } catch { /* */ }
    }
  }
  if (!url) throw Object.assign(new Error('Set a production domain in the DOMAIN panel first (or pass a url).'), { status: 400 });

  const [owner, repo] = project.github_repo.split('/');
  const token = await getGithubToken(user.id, { projectId });
  const { default_branch } = await (await fetch(`${GH_API}/repos/${owner}/${repo}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })).json();
  const branch = default_branch || 'main';

  const existing = await getFileContent(owner, repo, UPTIME_PATH, branch, token).catch(() => null);
  const content = uptimeWorkflowYaml(url, minutes);
  const result = await createOrUpdateFile(
    owner, repo, UPTIME_PATH, content, branch, token,
    existing ? `Update uptime monitoring (every ${minutes} min)` : `Add uptime monitoring for ${url}`,
    existing?.sha,
  );

  return {
    path: UPTIME_PATH,
    url,
    intervalMinutes: minutes,
    cron: cronFor(minutes),
    commitSha: result.commit?.sha || null,
    branch,
    repo: project.github_repo,
    updated: !!existing,
  };
}
