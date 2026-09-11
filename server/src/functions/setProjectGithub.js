// Set which GitHub repo a construct is connected to, and (for client work)
// an optional per-construct token — a fine-grained PAT scoped to a repo the
// owner's global GitHub connection doesn't cover. Stored encrypted;
// getGithubToken(userId, { projectId }) prefers it over the global one.
import { prisma } from '../db.js';
import { encrypt } from '../crypto.js';
import { getGithubToken } from '../lib/github.js';

const GH_API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function ghGet(path, token) {
  const res = await fetch(`${GH_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Morpheus' },
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

export default async function handler({ user, body }) {
  const { projectId, repo, token, clearToken } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  if (clearToken) {
    await prisma.project.update({ where: { id: projectId }, data: { github_token: null } });
    return { repo: project.github_repo, tokenScope: 'global' };
  }

  const nextRepo = repo != null ? String(repo).trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '') : project.github_repo;
  if (repo != null && nextRepo && !REPO_RE.test(nextRepo)) {
    throw Object.assign(new Error('Repo must be "owner/repo".'), { status: 400 });
  }

  const newToken = typeof token === 'string' && token.trim() ? token.trim() : null;

  // Verify: use the new token if one was given, else whatever the construct
  // resolves to now, against the target repo (or just the token if no repo).
  const testToken = newToken || await getGithubToken(user.id, { projectId }).catch(() => null);
  let canPush = null;
  if (testToken) {
    if (nextRepo) {
      const r = await ghGet(`/repos/${nextRepo}`, testToken);
      if (!r.ok) {
        throw Object.assign(
          new Error(r.status === 404
            ? `Can't see ${nextRepo} with ${newToken ? 'that token' : 'your GitHub connection'} — check the name and that the token has access.`
            : `GitHub returned ${r.status} for ${nextRepo}.`),
          { status: 400 },
        );
      }
      canPush = !!r.data?.permissions?.push;
    } else if (newToken) {
      const r = await ghGet('/user', testToken);
      if (!r.ok) throw Object.assign(new Error('That token was rejected by GitHub.'), { status: 400 });
    }
  }

  const data = {};
  if (repo != null) data.github_repo = nextRepo || null;
  if (newToken) data.github_token = encrypt(newToken);
  await prisma.project.update({ where: { id: projectId }, data });

  return {
    repo: nextRepo || null,
    tokenScope: newToken || project.github_token ? 'construct' : 'global',
    canPush,
  };
}
