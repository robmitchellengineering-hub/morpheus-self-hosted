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
import { decrypt, encrypt } from '../crypto.js';

const GH_API = 'https://api.github.com';

// ── Per-user connection (was githubConnection.ts) ───────────────────────────

// Returns { login, token } for the given user's linked GitHub account, or
// null if they haven't connected one. `token` is decrypted from storage.
//
// If this connection was made while the GitHub OAuth App's "Token
// expiration" optional feature was on, `expires_at` is set and the access
// token dies after ~8 hours. Rather than let every subsequent GitHub API
// call fail with "Bad credentials" until the user manually disconnects and
// reconnects, silently refresh it here first when it's expired or about to
// expire. Connections made with that feature off have expires_at = null and
// skip this entirely (their token never expires).
export async function getGithubConnection(userId) {
  const row = await prisma.githubConnection.findUnique({ where: { created_by_id: userId } });
  if (!row) return null;

  if (row.expires_at && row.expires_at.getTime() < Date.now() + 5 * 60 * 1000) {
    const refreshed = await tryRefreshGithubToken(row);
    if (refreshed) return refreshed;
    // Refresh failed (refresh_token itself expired/revoked — GitHub's
    // refresh tokens are valid ~6 months — or no client secret available
    // locally, e.g. a broker-issued connection). Fall through and hand back
    // the possibly-stale token; the caller's own GitHub API call will
    // surface a clear error if it's actually dead, same as before this fix.
  }

  return { login: row.login, token: decrypt(row.access_token) };
}

async function tryRefreshGithubToken(row) {
  if (!row.refresh_token || !process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) return null;
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: decrypt(row.refresh_token),
      }),
    });
    const data = await res.json();
    if (!data.access_token) {
      console.log(`GitHub token refresh failed for connection ${row.id}: ${data.error_description || data.error || 'no access_token in response'}`);
      return null;
    }
    const updated = await prisma.githubConnection.update({
      where: { id: row.id },
      data: {
        access_token: encrypt(data.access_token),
        scope: data.scope ?? row.scope,
        refresh_token: data.refresh_token ? encrypt(data.refresh_token) : row.refresh_token,
        expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
        refresh_token_expires_at: data.refresh_token_expires_in
          ? new Date(Date.now() + data.refresh_token_expires_in * 1000)
          : row.refresh_token_expires_at,
      },
    });
    return { login: updated.login, token: data.access_token };
  } catch (err) {
    console.log(`GitHub token refresh error for connection ${row.id}: ${err.message}`);
    return null;
  }
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

// Create a single blob, with retry-with-backoff on:
//  - GitHub's secondary rate limit (403/429/5xx) — compileProject pushes
//    dozens of files in a tight loop, which is exactly the shape GitHub's
//    abuse-detection rate limiter targets.
//  - HTTP 409 "Git Repository is empty" — confirmed live on a fresh
//    autoInit:false repo: repo creation on GitHub's side is itself
//    asynchronous, so the git/blobs endpoint can 409 for a brief window
//    right after createRepo returns 201, before the repo's storage backend
//    has finished provisioning. This is a different race than the
//    GitRPC::BadObjectState one (that was reading back auto_init's commit;
//    this is writing to a repo whose backend isn't ready yet), but the same
//    shape — retry through the window instead of failing on the first hit.
// With zero retries here, a single hit of either failed the whole compile
// with a bare "Failed to create blob for <path>" and no indication why
// (seen live on package.json, twice, for two different underlying reasons).
async function createBlob(token, repoFullName, file) {
  const h = ghHeaders(token);
  for (let attempt = 0; attempt < 6; attempt++) {
    const blobRes = await fetch(`${GH_API}/repos/${repoFullName}/git/blobs`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ content: file.content ?? '', encoding: 'utf-8' }),
    });
    if (blobRes.ok) return ghJson(blobRes);

    const err = await ghJson(blobRes);
    console.log(`Blob creation attempt ${attempt + 1}/6 failed for ${file.path}: status=${blobRes.status}, contentType=${typeof file.content}, contentLen=${file.content?.length ?? 'n/a'}, error=${JSON.stringify(err)}`);
    const retryable = blobRes.status === 409 || blobRes.status === 403 || blobRes.status === 429 || blobRes.status >= 500;
    if (!retryable || attempt === 5) {
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
    // createRepo call sites). Earlier attempt built the first commit
    // directly via git/blobs + git/trees + git/commits with no ref lookup,
    // to avoid re-reading an auto_init commit GitHub hadn't finished
    // committing yet (that was GitRPC::BadObjectState, fixed separately).
    // But live testing showed a *second*, unrelated restriction: GitHub's
    // Git Data API rejects git/blobs entirely on a truly empty repo — HTTP
    // 409 "Git Repository is empty" — and this is not a timing race, it
    // persisted through 6 retries and ~30s of backoff. The Contents API
    // (PUT .../contents/{path}) is the one GitHub endpoint documented to
    // work against a completely empty repo: it creates the file, the first
    // commit, and the default branch's ref in one atomic call. Use it once
    // to get the repo out of the empty state, then hand off to the same
    // battle-tested base_tree-merge path below (already retry-hardened for
    // the eventual-consistency window right after a repo/commit is created)
    // for the full file set — including re-pushing this same first file,
    // which is harmless since it's identical content at the same path.
    const initFile = files[0];
    const initPath = initFile.path.split('/').map(encodeURIComponent).join('/');
    const initRes = await fetch(`${GH_API}/repos/${repoFullName}/contents/${initPath}`, {
      method: 'PUT', headers: h,
      body: JSON.stringify({
        message: commitMessage,
        content: Buffer.from(initFile.content ?? '', 'utf-8').toString('base64'),
      }),
    });
    if (!initRes.ok) {
      const err = await ghJson(initRes);
      throw new Error(`Failed to initialize empty repo via ${initFile.path} (HTTP ${initRes.status}): ` + (err.message || JSON.stringify(err)));
    }
  }

  // Existing repo, or a brand-new one just initialized above, that may
  // already have real content (e.g. a user re-pushing
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

  // Round 5 fix (this replaces the old base_tree-merge approach below,
  // which kept failing live with `422 GitRPC::BadObjectState` on
  // git/trees — sometimes dozens of times in a row over several minutes,
  // never resolving no matter how many retries or how long the backoff.
  // That's the same error other GitHub API integrations hit on this exact
  // endpoint (e.g. dependabot/dependabot-core#10280, still open/unresolved
  // upstream as of this writing) — it appears tied to GitHub's own
  // base_tree inheritance/merge logic itself, not a timing race, since it
  // was surfacing as a real 422 (not a 5xx/429 transient status) and
  // persisted well past any plausible eventual-consistency window.
  //
  // Fix: stop asking GitHub to merge our new files onto an existing tree
  // via `base_tree` at all. Instead, read the existing tree ourselves
  // (recursively, so nested paths come back flat), merge our new/changed
  // files into that map in our own code, and POST the complete resulting
  // file list as a brand-new tree with NO `base_tree` field. GitHub's
  // create-tree endpoint builds the full directory hierarchy from flat
  // "a/b/c" paths on its own, so this still only needs blob entries, not
  // explicit tree/directory entries. This sidesteps whatever in GitHub's
  // base_tree merge path was producing BadObjectState, rather than just
  // retrying the same request that provokes it.
  const existingBlobs = new Map(); // path -> { sha, mode }
  let gotExistingTree = false;
  let lastExistingTreeErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const existingTreeRes = await fetch(`${GH_API}/repos/${repoFullName}/git/trees/${baseTreeSha}?recursive=1`, { headers: h });
    if (existingTreeRes.ok) {
      const existingTreeData = await ghJson(existingTreeRes);
      for (const entry of existingTreeData.tree || []) {
        if (entry.type === 'blob') existingBlobs.set(entry.path, { sha: entry.sha, mode: entry.mode || '100644' });
      }
      if (existingTreeData.truncated) {
        console.log(`Existing tree fetch for ${repoFullName}@${baseTreeSha} was truncated by GitHub (very large repo) — proceeding with the ${existingBlobs.size} entries returned.`);
      }
      gotExistingTree = true;
      break;
    }
    const existingTreeErr = await ghJson(existingTreeRes);
    lastExistingTreeErr = existingTreeErr.message || JSON.stringify(existingTreeErr);
    console.log(`Existing-tree fetch attempt ${attempt + 1}/5: status=${existingTreeRes.status}, repo=${repoFullName}, baseTree=${baseTreeSha}, error=${JSON.stringify(existingTreeErr)}`);
    if (existingTreeRes.status === 401 || existingTreeRes.status === 403) throw new Error('Failed to read existing tree: ' + lastExistingTreeErr);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  if (!gotExistingTree) throw new Error(`Failed to read existing tree after retries (repo=${repoFullName}, baseTree=${baseTreeSha}): ${lastExistingTreeErr}`);

  // Create blobs for all files being pushed this round, and merge them
  // into the existing-file map (overriding any same-path entry).
  for (const file of files) {
    const blob = await createBlob(token, repoFullName, file);
    existingBlobs.set(file.path, { sha: blob.sha, mode: '100644' });
  }
  const treeItems = Array.from(existingBlobs.entries()).map(([path, entry]) => ({
    path, mode: entry.mode, type: 'blob', sha: entry.sha,
  }));

  // Create the new tree from the fully-merged file list — no base_tree,
  // so this doesn't invoke GitHub's merge logic at all. Retry loop kept
  // as a generic safety net for ordinary transient failures (5xx/429).
  //
  // 2026-09-03, round six: Rob hit `GitRPC::BadObjectState` again on this
  // exact endpoint (compiling a Mac app, repo=morpheus-build-anypdf-...,
  // items=20) even with base_tree already removed. Round 5's theory (it was
  // GitHub's base_tree merge logic specifically) explained some cases but
  // not this one: this hit on a BRAND-NEW repo's very first real multi-file
  // push, seconds after the atomic single-file init commit above (isNewRepo
  // path) — i.e. every object involved (repo, first commit, ~20 new blobs)
  // was only milliseconds old when this POST fired. That's a GitHub-side
  // object-store replication race on a still-settling repo, not a request
  // shape problem — the same wall other integrations hit on this endpoint
  // (dependabot/dependabot-core#10280 among others), and one that's
  // reported to clear given enough time rather than being permanent.
  // Giving it a genuinely long runway (not shape-changing the request
  // again) is the fix: BadObjectState specifically gets up to ~75s of
  // backoff across 7 attempts instead of the old 30s/5 attempts, since 30s
  // clearly wasn't always enough; any other error (a real, likely
  // non-transient problem) keeps the original short/fast retry so this
  // doesn't turn a genuine failure into a 75s hang for no reason.
  let tree = null;
  let lastTreeErr = null;
  for (let attempt = 0; ; attempt++) {
    const treeRes = await fetch(`${GH_API}/repos/${repoFullName}/git/trees`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ tree: treeItems }),
    });
    if (treeRes.ok) { tree = await ghJson(treeRes); break; }
    const treeErr = await ghJson(treeRes);
    lastTreeErr = treeErr.message || JSON.stringify(treeErr);
    const isBadObjectState = /BadObjectState/i.test(lastTreeErr);
    const maxAttempts = isBadObjectState ? 7 : 5;
    console.log(`Tree attempt ${attempt + 1}/${maxAttempts}${isBadObjectState ? ' (BadObjectState, extended backoff)' : ''}: status=${treeRes.status}, repo=${repoFullName}, items=${treeItems.length}, error=${JSON.stringify(treeErr)}`);
    if (treeRes.status === 401 || treeRes.status === 403) throw new Error('Failed to create tree: ' + lastTreeErr);
    if (attempt + 1 >= maxAttempts) break;
    const delayMs = isBadObjectState ? Math.min(5000 * (attempt + 1), 15000) : 2000 * (attempt + 1);
    await new Promise(r => setTimeout(r, delayMs));
  }
  if (!tree) {
    const retrySuggestion = /BadObjectState/i.test(lastTreeErr)
      ? ' This is a known GitHub-side timing issue on brand-new repos, not a Morpheus bug — retrying the compile usually succeeds.'
      : '';
    throw new Error(`Failed to create tree after retries (repo=${repoFullName}, branch=${branch}, items=${treeItems.length}): ${lastTreeErr}${retrySuggestion}`);
  }

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
