import { prisma } from '../db.js';
import { decrypt } from '../crypto.js';

const GITHUB_API_ROOT = 'https://api.github.com';

// Retrieve the user's GitHub connection and decrypt the access token.
export async function getGithubConnection(userId) {
  const connection = await prisma.githubConnection.findUnique({
    where: { created_by_id: userId },
  });
  if (!connection) {
    throw Object.assign(new Error('GitHub account not connected'), { status: 403 });
  }
  return {
    login: connection.login,
    accessToken: decrypt(connection.access_token),
  };
}

// Minimal GitHub REST client.
async function githubFetch(path, { token, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${GITHUB_API_ROOT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `GitHub API ${res.status}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

// Fetch the full recursive tree for a branch, returning only blobs.
// Each entry: { path, sha, mode }
export async function fetchRemoteTree(owner, repo, branch, token) {
  const data = await githubFetch(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { token });
  return (data.tree || [])
    .filter((entry) => entry.type === 'blob')
    .map((entry) => ({
      path: entry.path,
      sha: entry.sha,
      mode: entry.mode || '100644',
    }));
}

// Create or update a single file via the Contents API.
export async function createOrUpdateFile(owner, repo, path, content, branch, token, message, sha) {
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;
  return githubFetch(`/repos/${owner}/${repo}/contents/${path}`, {
    token,
    method: 'PUT',
    body,
  });
}

// Delete a single file via the Contents API.
export async function deleteFile(owner, repo, path, branch, sha, token, message) {
  const body = {
    message,
    branch,
    sha,
  };
  return githubFetch(`/repos/${owner}/${repo}/contents/${path}`, {
    token,
    method: 'DELETE',
    body,
  });
}
