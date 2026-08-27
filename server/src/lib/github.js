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

// Create a single blob, with retry-with-backoff on GitHub's secondary rate
// limit. compileProject pushes ~dozens of files in a tight loop right after
// creating a brand-new repo — that burst of back-to-back POSTs is exactly
// the shape GitHub's abuse-detection rate limiter targets, and with zero
// retries here a single hit failed the whole compile with a bare "Failed to
// create blob for <path>" and no indication why (seen live on package.json).
async function createBlob(token, repoFullName, file) {
  const h = ghHeaders(token);
  for (let attempt = 0; attempt < 4; attempt++) {
    const blobRes = await fetch(`${GH_API}/repos/${repoFullName}/git/blobs`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ content: file.content ?? '', encoding: 'utf-8' }),
    });
    if (blobRes.ok) return ghJson(blobRes);

    const err = await ghJson(blobRes);
    console.log(`Blob creation attempt ${attempt + 1}/4 failed for ${file.path}: status=${blobRes.status}, contentType=${typeof file.content}, contentLen=${file.content?.length ?? 'n/a'}, error=${JSON.stringify(err)}`);
    const retryable = blobRes.status === 403 || blobRes.status === 429 || blobRes.status >= 500;
    if (!retryable || attempt === 3) {
      throw new Error(`Failed to create blob for ${file.path} (HTTP ${blobRes.status}): ${err.message || JSON.stringify(err)}`);
    }
    const retryAfterHeader = Number(blobRes.headers.get('retry-after'));
    const retryAfterSeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : 2 * (attempt + 1);
    await new Promise((r) => setTimeout(r, retryAfterSeconds * 1000));
  }
}

export async function createRepo(token, repoName, isPrivate, { autoInit = true } = {}) {
  const h = ghHeaders(token);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${GH_API}/user/repos`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ name: repoName, private: isPrivate, auto_init: autoInit }),
    });
    if (res.status === 422) {
      const ghUser = await getGhUser(token);
      const existingRes = await fetch(`${GH_API}/repos/${ghUser.login}/${repoName}`, { headers: h });
      const existing = await ghJson(existingRes);
      // Flag this so pushFiles knows it's appending to a repo that may
      // already have real content, not building a first commit from scratch.
      return { ...existing, _isNewRepo: false };
    }
    if (res.ok) {
      const created = await ghJson(res);
      return { ...created, _isNewRepo: true };
    }

    const body = await ghJson(res);
    // GitHub's secondary rate limit on rapid repo creation comes back as
    // 403 (sometimes 429), often with a Retry-After header. Morpheus can
    // create many repos in quick succession — one per compile attempt,
    // including automatic AI fix-loop retries — so a single hit of this
    // used to fail the whole compile with a bare "Failed to create
    // repository" and no indication why. Back off and retry instead.
    console.log(`createRepo attempt ${attempt + 1}/3 failed: status=${res.status}, name=${repoName}, error=${JSON.stringify(body)}`);
    const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 2) return body;
    const retryAfterHeader = Number(res.headers.get('retry-after'));
    const retryAfterSeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : 5 * (attempt + 1);
    await new Promise((r) => setTimeout(r, retryAfterSeconds * 1000));
  }
}

export async function pushFiles(token, repoFullName, files, commitMessage, { isNewRepo = false } = {}) {
  const h = ghHeaders(token);

  if (isNewRepo) {
    // Brand-new, still-empty repo (created with auto_init:false — see
    // createRepo call sites). Build the very first commit directly instead
    // of reading back an auto-init'd branch/commit/tree we didn't create
    // ourselves. That read-after-write dependency is exactly what kept
    // failing in production: GitHub's Git Data API is briefly inconsistent
    // right after auto_init creates the first commit asynchronously, and
    // retrying through that window (5 attempts, growing backoff) turned out
    // to not be enough — GitRPC::BadObjectState kept recurring on some
    // pushes even after 30+ seconds of retries. With no prior commit to
    // read back, there's nothing to race against: no ref lookup, no parent-
    // commit lookup, no base_tree. Just create objects and point a new ref
    // at them.
    const repoRes = await fetch(`${GH_API}/repos/${repoFullName}`, { headers: h });
    const repoData = await ghJson(repoRes);
    const branch = repoData.default_branch || 'main';

    const treeItems = [];
    for (const file of files) {
      const blob = await createBlob(token, repoFullName, file);
      treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const treeRes = await fetch(`${GH_API}/repos/${repoFullName}/git/trees`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ tree: treeItems }),
    });
    if (!treeRes.ok) {
      const err = await ghJson(treeRes);
      throw new Error('Failed to create tree: ' + (err.message || JSON.stringify(err)));
    }
    const tree = await ghJson(treeRes);

    const commitRes = await fetch(`${GH_API}/repos/${repoFullName}/git/commits`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ message: commitMessage, tree: tree.sha, parents: [] }),
    });
    if (!commitRes.ok) throw new Error('Failed to create commit');
    const commit = await ghJson(commitRes);

    const refRes = await fetch(`${GH_API}/repos/${repoFullName}/git/refs`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
    if (!refRes.ok) {
      const err = await ghJson(refRes);
      throw new Error('Failed to create branch ref: ' + (err.message || JSON.stringify(err)));
    }

    return { branch, commitSha: commit.sha };
  }

  // Existing repo that may already have real content (e.g. a user re-pushing
  // to a repo they picked a name for in uploadToGithub.js) — merge onto it
  // via base_tree so existing files are preserved, same as before. Still
  // retry-hardened for the same eventual-consistency window, in case this
  // is also the very first push right after the repo was created.

  // Get the repo's default branch
  const repoRes = await fetch(`${GH_API}/repos/${repoFullName}`, { headers: h });
  const repoData = await ghJson(repoRes);
  const branch = repoData.default_branch || 'main';

  // Get the branch ref's latest commit — retry; same race as the tree step below.
  let parentSha = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const refRes = await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${branch}`, { headers: h });
    const refData = await ghJson(refRes);
    parentSha = refData.object?.sha;
    if (parentSha) break;
    console.log(`Ref lookup attempt ${attempt + 1}/5: status=${refRes.status}, repo=${repoFullName}, branch=${branch}, error=${JSON.stringify(refData)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!parentSha) throw new Error(`Could not find branch ref for ${repoFullName}@${branch} after retries`);

  // Get the parent commit's tree — same retry treatment.
  let baseTreeSha = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const commitRes = await fetch(`${GH_API}/repos/${repoFullName}/git/commits/${parentSha}`, { headers: h });
    const parentCommit = await ghJson(commitRes);
    baseTreeSha = parentCommit.tree?.sha;
    if (baseTreeSha) break;
    console.log(`Parent commit lookup attempt ${attempt + 1}/5: status=${commitRes.status}, repo=${repoFullName}, sha=${parentSha}, error=${JSON.stringify(parentCommit)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!baseTreeSha) throw new Error(`Could not find base tree for ${repoFullName}@${parentSha} after retries`);

  // Create blobs for all files
  const treeItems = [];
  for (const file of files) {
    const blob = await createBlob(token, repoFullName, file);
    treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Create a new tree with all files (base_tree preserves existing files like README).
  // Retry on any failure here, not just 404 — GitHub has been observed
  // returning a non-404 status with a "GitRPC::BadObjectState" body for
  // this exact same "repo just created" race, which the old 404-only check
  // treated as fatal on the very first attempt. 401/403 are real
  // auth/permission failures, not races, so those still fail fast.
  let tree = null;
  let lastTreeErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const treeRes = await fetch(`${GH_API}/repos/${repoFullName}/git/trees`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
    });
    if (treeRes.ok) { tree = await ghJson(treeRes); break; }
    const treeErr = await ghJson(treeRes);
    lastTreeErr = treeErr.message || JSON.stringify(treeErr);
    console.log(`Tree attempt ${attempt + 1}/5: status=${treeRes.status}, repo=${repoFullName}, baseTree=${baseTreeSha}, items=${treeItems.length}, error=${JSON.stringify(treeErr)}`);
    if (treeRes.status === 401 || treeRes.status === 403) throw new Error('Failed to create tree: ' + lastTreeErr);
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  if (!tree) throw new Error(`Failed to create tree after retries (repo=${repoFullName}, branch=${branch}, baseTree=${baseTreeSha}, items=${treeItems.length}): ${lastTreeErr}`);

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
