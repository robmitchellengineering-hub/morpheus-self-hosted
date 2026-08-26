// Ported from base44/shared/githubConnection.ts + base44/shared/githubPush.ts
// (merged into one file per PORTING_GUIDE.md).
//
// githubConnection.ts originally read the per-user GitHub OAuth token via
// `base44.asServiceRole.connectors.getCurrentAppUserConnection(connectorId)`.
// Here that's replaced by reading our own `GithubConnection` Prisma row
// (written by routes/connections.routes.js, access_token encrypted at rest
// via crypto.js's encrypt()).
//
// githubPush.ts's REST/Git-Data-API logic (repo create/reuse, blob/tree/commit
// push with retry, Actions-secret sealing) is ported verbatim below, using
// Node 22's built-in fetch instead of Deno's.
import { prisma } from '../db.js';
import { decrypt } from '../crypto.js';

const GH_API = 'https://api.github.com';

// ── Per-user connection (was githubConnection.ts) ───────────────────────────

// Returns { login, token } for the given user's linked GitHub account, or
// null if they haven't connected one. `token` is decrypted from storage.
export async function getGithubConnection(userId) {
  const row = await prisma.githubConnection.findUnique({ where: { created_by_id: userId } });
  if (!row) return null;
  return { login: row.login, token: decrypt(row.access_token) };
}

// Returns the current app user's GitHub access token, or throws a friendly
// error if they haven't connected their GitHub account yet.
// (was getAppUserGithubToken(base44) in githubConnection.ts)
export async function getGithubToken(userId) {
  const connection = await getGithubConnection(userId);
  if (!connection?.token) {
    throw Object.assign(new Error('GitHub not connected — connect it in Settings'), { status: 400 });
  }
  return connection.token;
}

// Returns the current app user's GitHub login name, or null if not connected.
// (was getAppUserGithubLogin(base44) in githubConnection.ts — the original
// re-fetched /user from GitHub on every call; we already have the login
// cached from connect-time, so this just reads the stored row.)
export async function getGithubLogin(userId) {
  const connection = await getGithubConnection(userId);
  return connection?.login || null;
}

// ── GitHub REST / Git Data API (was githubPush.ts, ported verbatim) ────────

export function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Morpheus',
  };
}

export async function ghJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _error: text }; }
}

export async function getGhUser(token) {
  const res = await fetch(`${GH_API}/user`, { headers: ghHeaders(token) });
  return ghJson(res);
}

export async function createRepo(token, repoName, isPrivate) {
  const h = ghHeaders(token);
  const res = await fetch(`${GH_API}/user/repos`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ name: repoName, private: isPrivate, auto_init: true }),
  });
  if (res.status === 422) {
    const ghUser = await getGhUser(token);
    const existingRes = await fetch(`${GH_API}/repos/${ghUser.login}/${repoName}`, { headers: h });
    return ghJson(existingRes);
  }
  return ghJson(res);
}

export async function pushFiles(token, repoFullName, files, commitMessage) {
  const h = ghHeaders(token);

  // Get the repo's default branch
  const repoRes = await fetch(`${GH_API}/repos/${repoFullName}`, { headers: h });
  const repoData = await ghJson(repoRes);
  const branch = repoData.default_branch || 'main';

  // Get the branch ref's latest commit
  const refRes = await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${branch}`, { headers: h });
  const refData = await ghJson(refRes);
  const parentSha = refData.object?.sha;
  if (!parentSha) throw new Error('Could not find branch ref');

  // Get the parent commit's tree
  const commitRes = await fetch(`${GH_API}/repos/${repoFullName}/git/commits/${parentSha}`, { headers: h });
  const parentCommit = await ghJson(commitRes);
  const baseTreeSha = parentCommit.tree?.sha;

  // Create blobs for all files
  const treeItems = [];
  for (const file of files) {
    const blobRes = await fetch(`${GH_API}/repos/${repoFullName}/git/blobs`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
    });
    if (!blobRes.ok) throw new Error(`Failed to create blob for ${file.path}`);
    const blob = await ghJson(blobRes);
    treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Create a new tree with all files (base_tree preserves existing files like README)
  // Retry on 404 — GitHub sometimes isn't ready right after repo creation
  let tree = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const treeRes = await fetch(`${GH_API}/repos/${repoFullName}/git/trees`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
    });
    if (treeRes.ok) { tree = await ghJson(treeRes); break; }
    const treeErr = await ghJson(treeRes);
    console.log(`Tree attempt ${attempt + 1}: status=${treeRes.status}, repo=${repoFullName}, baseTree=${baseTreeSha}, items=${treeItems.length}, error=${JSON.stringify(treeErr)}`);
    if (treeRes.status !== 404) throw new Error('Failed to create tree: ' + (treeErr.message || JSON.stringify(treeErr)));
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!tree) throw new Error(`Failed to create tree after retries (repo=${repoFullName}, branch=${branch}, baseTree=${baseTreeSha}, items=${treeItems.length})`);

  // Create a commit pointing to the new tree
  const newCommitRes = await fetch(`${GH_API}/repos/${repoFullName}/git/commits`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ message: commitMessage, tree: tree.sha, parents: [parentSha] }),
  });
  if (!newCommitRes.ok) throw new Error('Failed to create commit');
  const newCommit = await ghJson(newCommitRes);

  // Update the branch ref to point to the new commit
  const updateRefRes = await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${branch}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({ sha: newCommit.sha }),
  });
  if (!updateRefRes.ok) throw new Error('Failed to update branch ref');

  return { branch, commitSha: newCommit.sha };
}

// Encrypt a secret value with a repository's public key and set it as a
// GitHub Actions secret. GitHub requires NaCl sealed-box encryption — the
// raw value cannot be sent as encrypted_value (it would be stored as garbage
// and the workflow would fail with "secret not found").
//
// NOTE: requires the `libsodium-wrappers` npm package (not currently in
// server/package.json — this port did not add it per "don't touch other
// files"; add it before this function is exercised).
export async function encryptAndSetGithubSecret(token, repoFullName, secretName, secretValue) {
  const h = ghHeaders(token);

  // 1. Get the repo's public key
  const keyRes = await fetch(`${GH_API}/repos/${repoFullName}/actions/secrets/public-key`, { headers: h });
  if (!keyRes.ok) return { ok: false, error: `Failed to get repo public key (${keyRes.status})` };
  const keyData = await keyRes.json();
  const publicKey = keyData.key;
  const keyId = keyData.key_id;

  // 2. Encrypt with NaCl sealed box (libsodium)
  const sodium = await import('libsodium-wrappers');
  await sodium.default.ready;
  const binKey = sodium.default.from_base64(publicKey, sodium.default.base64_variants.ORIGINAL);
  const binSecret = sodium.default.from_string(secretValue);
  const encrypted = sodium.default.crypto_box_seal(binSecret, binKey);
  const encryptedB64 = sodium.default.to_base64(encrypted, sodium.default.base64_variants.ORIGINAL);

  // 3. Set the secret
  const setRes = await fetch(`${GH_API}/repos/${repoFullName}/actions/secrets/${secretName}`, {
    method: 'PUT', headers: h,
    body: JSON.stringify({ encrypted_value: encryptedB64, key_id: keyId }),
  });
  if (!setRes.ok) {
    const err = await setRes.text().catch(() => '');
    return { ok: false, error: `Failed to set secret (${setRes.status}): ${err.substring(0, 100)}` };
  }
  return { ok: true };
}
