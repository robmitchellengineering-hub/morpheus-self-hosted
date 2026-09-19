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

// Returns { login, token, accessToken } for the given user's linked GitHub
// account, or null if they haven't connected one. `token`/`accessToken` are
// both the same decrypted value — two names for the same field.
//
// 2026-09-08 fix (Rob's AnyPDF compile kept failing with no Swift-specific
// error to chase): Morpheus's own self-dev feature had rewritten this whole
// file on 2026-09-06 (commit fb2020f, "Self-dev update via Morpheus") to a
// much smaller version built only for pushSelfDevToGithub.js's needs —
// dropping getGithubToken/createRepo/pushFiles/ghHeaders/ghJson/getGhUser/
// encryptAndSetGithubSecret entirely and changing this function's return
// shape from {login, token} to {login, accessToken}. That silently broke
// EVERY other caller of this file the moment it deployed: compileProject.js,
// saveCompiledArtifacts.js, getCompileStatus.js, deployBackend.js,
// generateRebuildDoc.js, checkGithubConnection.js, importFromGithub.js, and
// workflow-renderer.js all import functions that version no longer
// exported — a hard ESM "does not provide an export named ..." failure at
// import time, not a build-specific bug. That's a highly plausible
// explanation for "still failing to compile" reports with no new
// Swift-specific error to show for it: every compile attempt would have
// died before ever reaching GitHub Actions.
// This session's cleanupBuildRepos.js work (github.js edits earlier
// 2026-09-08) re-uploaded the pre-2026-09-06 version of this file wholesale
// via GitHub's browser-upload flow (this sandbox has no working git
// push/pull, so there was no diff/merge step to catch the conflict) — which
// fixed the callers above but broke pushSelfDevToGithub.js the same way in
// reverse, since IT now expects getGithubConnection().accessToken plus
// fetchRemoteTree/createOrUpdateFile/deleteFile (added below). Exposing both
// `token` and `accessToken` here, and keeping every function from both
// versions of this file, is the actual fix: every real caller's needs are a
// strict superset now, not a set of trade-offs between them.
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

  const token = decrypt(row.access_token);
  return { login: row.login, token, accessToken: token };
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
    return { login: updated.login, token: data.access_token, accessToken: data.access_token };
  } catch (err) {
    console.log(`GitHub token refresh error for connection ${row.id}: ${err.message}`);
    return null;
  }
}

// Returns the GitHub access token to use for a given user, or throws a
// friendly error if there's none.
//
// With { projectId }: if that project has its own stored token
// (Project.github_token — a per-construct PAT for client work whose repo
// isn't covered by the owner's global connection), that wins. Otherwise —
// and for every existing caller that passes no projectId — it's the user's
// global GitHub OAuth connection.
// (was getAppUserGithubToken(base44) in githubConnection.ts)
export async function getGithubToken(userId, { projectId } = {}) {
  if (projectId) {
    try {
      const p = await prisma.project.findFirst({
        where: { id: projectId, created_by_id: userId },
        select: { github_token: true },
      });
      if (p?.github_token) return decrypt(p.github_token);
    } catch {
      // column not migrated yet, or a bad ciphertext — fall back to global
    }
  }
  const connection = await getGithubConnection(userId);
  if (!connection?.token) {
    throw Object.assign(
      new Error('GitHub not connected — connect it in Settings, or set a token for this construct in the WEBSITE panel → Code tab.'),
      { status: 400 },
    );
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

// `deletePaths` (optional): paths to REMOVE from the repo in this same
// commit. They're dropped from the merged tree below, so the single commit
// this makes is create + update + delete in one shot. Used by
// pushSelfDevToGithub.js; empty/absent for every other caller (compile
// pipeline, uploadToGithub), which only ever add/update.
//
// `targetBranch` (optional): commit onto this branch instead of the repo's
// default branch. If it doesn't exist yet it's created from `baseBranch`
// (or the default branch) head first — so pushSelfDevToGithub.js can land a
// change on a fresh `self-dev/<ts>` branch for a PR instead of straight on
// main. Absent for every other caller, which always target the default branch.
export async function pushFiles(token, repoFullName, files, commitMessage, { isNewRepo = false, deletePaths = [], targetBranch = null, baseBranch = null, incremental = false } = {}) {
  const h = ghHeaders(token);

  // Incremental path — commit each changed file directly via the Contents
  // API onto `targetBranch`, one commit per file. The tree-rebuild path
  // below reads the WHOLE repo tree and POSTs it back, which GitHub 500s on
  // a large repo (a full WordPress install is ~27k blobs). This path never
  // touches the full tree, so it scales to any repo size — used by the
  // WordPress delivery adapter, whose changes are always a few files inside
  // a big install. Requires a target branch and no deletions.
  if (incremental && targetBranch) {
    const repoData0 = await ghJson(await fetch(`${GH_API}/repos/${repoFullName}`, { headers: h }));
    const defaultBranch0 = repoData0.default_branch || 'main';
    // Create the branch off base if it doesn't exist yet.
    const existRef = await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${targetBranch}`, { headers: h });
    if (existRef.status === 404) {
      const from = baseBranch || defaultBranch0;
      const baseRef = await ghJson(await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${from}`, { headers: h }));
      const baseSha = baseRef.object?.sha;
      if (!baseSha) throw new Error(`Could not read ${repoFullName}@${from} to branch from`);
      const cr = await fetch(`${GH_API}/repos/${repoFullName}/git/refs`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ ref: `refs/heads/${targetBranch}`, sha: baseSha }),
      });
      if (!cr.ok && cr.status !== 422) throw new Error(`Failed to create branch ${targetBranch}: ${(await ghJson(cr)).message || cr.status}`);
    }
    let lastCommitSha = null;
    for (const file of files) {
      const encPath = file.path.split('/').map(encodeURIComponent).join('/');
      // Current blob sha on this branch, if the file already exists.
      let sha;
      const cur = await fetch(`${GH_API}/repos/${repoFullName}/contents/${encPath}?ref=${targetBranch}`, { headers: h });
      if (cur.ok) sha = (await ghJson(cur)).sha;
      const put = await fetch(`${GH_API}/repos/${repoFullName}/contents/${encPath}`, {
        method: 'PUT', headers: h,
        body: JSON.stringify({
          message: files.length > 1 ? `${commitMessage} — ${file.path}` : commitMessage,
          content: Buffer.from(file.content ?? '', 'utf-8').toString('base64'),
          branch: targetBranch,
          ...(sha ? { sha } : {}),
        }),
      });
      if (!put.ok) throw new Error(`Failed to write ${file.path} (HTTP ${put.status}): ${(await ghJson(put)).message || put.status}`);
      lastCommitSha = (await ghJson(put)).commit?.sha || lastCommitSha;
    }
    return { branch: targetBranch, commitSha: lastCommitSha };
  }

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
  const defaultBranch = repoData.default_branch || 'main';
  const branch = targetBranch || defaultBranch;

  // Pushing to a non-default branch that doesn't exist yet: create it from
  // baseBranch (or the default branch) head so the commit below has a parent.
  if (targetBranch && targetBranch !== defaultBranch) {
    const existingRef = await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${branch}`, { headers: h });
    if (existingRef.status === 404) {
      const fromBranch = baseBranch || defaultBranch;
      const baseRefData = await ghJson(await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${fromBranch}`, { headers: h }));
      const baseSha = baseRefData.object?.sha;
      if (!baseSha) throw new Error(`Could not read ${repoFullName}@${fromBranch} to branch ${branch} from`);
      const createRefRes = await fetch(`${GH_API}/repos/${repoFullName}/git/refs`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
      });
      // 422 = ref already exists (a race with a concurrent push) — fine.
      if (!createRefRes.ok && createRefRes.status !== 422) {
        throw new Error(`Failed to create branch ${branch}: ${(await ghJson(createRefRes)).message || createRefRes.status}`);
      }
    }
  }

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
  // Drop deleted paths from the merged tree — a path that's absent from the
  // final tree is removed from the repo by the commit.
  for (const path of deletePaths || []) existingBlobs.delete(path);
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

// Revert a commit on the repo's default branch by pointing a new commit at
// the reverted commit's PARENT tree — i.e. restore the whole repo to exactly
// how it was just before `commitSha`, as one new commit (no force-push, no
// history rewrite). Used by revertSelfDevPush.js for an instant production
// rollback.
//
// Refuses if the branch head has moved past `commitSha` since — at that
// point a tree-swap would also silently undo whatever landed in between, so
// the caller is told to revert by hand instead.
export async function revertCommit(token, repoFullName, commitSha) {
  const h = ghHeaders(token);

  const repoData = await ghJson(await fetch(`${GH_API}/repos/${repoFullName}`, { headers: h }));
  const branch = repoData.default_branch || 'main';

  const refData = await ghJson(await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${branch}`, { headers: h }));
  const headSha = refData.object?.sha;
  if (!headSha) throw Object.assign(new Error(`Could not read ${repoFullName}@${branch} head`), { status: 502 });
  if (headSha !== commitSha) {
    throw Object.assign(new Error(`${branch} has moved on since that commit — revert it manually on GitHub.`), { status: 409 });
  }

  const commit = await ghJson(await fetch(`${GH_API}/repos/${repoFullName}/git/commits/${commitSha}`, { headers: h }));
  const parentSha = commit.parents?.[0]?.sha;
  if (!parentSha) throw Object.assign(new Error('That commit has no parent — nothing to revert to.'), { status: 400 });
  const parent = await ghJson(await fetch(`${GH_API}/repos/${repoFullName}/git/commits/${parentSha}`, { headers: h }));
  const parentTreeSha = parent.tree?.sha;
  if (!parentTreeSha) throw Object.assign(new Error('Could not read the pre-commit tree.'), { status: 502 });

  const firstLine = String(commit.message || '').split('\n')[0].slice(0, 80);
  const newCommitRes = await fetch(`${GH_API}/repos/${repoFullName}/git/commits`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      message: `Revert "${firstLine}"\n\nRolls the repo back to ${parentSha.slice(0, 7)} (state before ${commitSha.slice(0, 7)}).`,
      tree: parentTreeSha,
      parents: [headSha],
    }),
  });
  if (!newCommitRes.ok) throw new Error(`Failed to create revert commit: ${(await ghJson(newCommitRes)).message || newCommitRes.status}`);
  const newCommit = await ghJson(newCommitRes);

  const updateRefRes = await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${branch}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({ sha: newCommit.sha }),
  });
  if (!updateRefRes.ok) throw new Error(`Failed to move ${branch} to the revert commit: ${(await ghJson(updateRefRes)).message || updateRefRes.status}`);

  return { commitSha: newCommit.sha, revertedToSha: parentSha, branch };
}

// List recent commits on a repo's default branch — for the DOMAIN panel's
// rollback picker. Each entry: { sha, shortSha, message, author, date, url }.
export async function listRecentCommits(token, repoFullName, { perPage = 20 } = {}) {
  const h = ghHeaders(token);
  const repoData = await ghJson(await fetch(`${GH_API}/repos/${repoFullName}`, { headers: h }));
  const branch = repoData.default_branch || 'main';
  const res = await fetch(`${GH_API}/repos/${repoFullName}/commits?sha=${branch}&per_page=${Math.min(perPage, 100)}`, { headers: h });
  const data = await ghJson(res);
  if (!res.ok) throw Object.assign(new Error(data.message || `GitHub API ${res.status}`), { status: res.status });
  return {
    branch,
    headSha: data[0]?.sha || null,
    commits: (data || []).map((c) => ({
      sha: c.sha,
      shortSha: String(c.sha).slice(0, 7),
      message: String(c.commit?.message || '').split('\n')[0].slice(0, 120),
      author: c.commit?.author?.name || c.author?.login || 'unknown',
      date: c.commit?.author?.date || null,
      url: c.html_url,
    })),
  };
}

// Roll the default branch back to the exact tree of `targetSha`, as ONE new
// commit whose parent is the current head — no force-push, no history
// rewrite, fully auditable. The connected host redeploys on the push. Use
// this (not revertCommit) when rolling back past more than the last commit.
export async function rollbackToCommit(token, repoFullName, targetSha) {
  const h = ghHeaders(token);

  const repoData = await ghJson(await fetch(`${GH_API}/repos/${repoFullName}`, { headers: h }));
  const branch = repoData.default_branch || 'main';

  const refData = await ghJson(await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${branch}`, { headers: h }));
  const headSha = refData.object?.sha;
  if (!headSha) throw Object.assign(new Error(`Could not read ${repoFullName}@${branch} head`), { status: 502 });
  if (headSha === targetSha) {
    throw Object.assign(new Error('That is already the current state of the branch.'), { status: 400 });
  }

  const targetRes = await fetch(`${GH_API}/repos/${repoFullName}/commits/${targetSha}`, { headers: h });
  const target = await ghJson(targetRes);
  if (!targetRes.ok) throw Object.assign(new Error(target.message || `Commit ${targetSha} not found`), { status: targetRes.status });
  const targetTreeSha = target.commit?.tree?.sha;
  if (!targetTreeSha) throw Object.assign(new Error('Could not read that commit’s file tree.'), { status: 502 });

  const targetSummary = String(target.commit?.message || '').split('\n')[0].slice(0, 80);
  const newCommitRes = await fetch(`${GH_API}/repos/${repoFullName}/git/commits`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      message: `Roll back to ${String(targetSha).slice(0, 7)} — "${targetSummary}"\n\nRestores every file to the state at ${String(targetSha).slice(0, 7)}. Forward commit on ${branch}; nothing is rewritten.`,
      tree: targetTreeSha,
      parents: [headSha],
    }),
  });
  const newCommit = await ghJson(newCommitRes);
  if (!newCommitRes.ok) throw Object.assign(new Error(`Failed to create rollback commit: ${newCommit.message || newCommitRes.status}`), { status: 502 });

  const updateRefRes = await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${branch}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({ sha: newCommit.sha }),
  });
  if (!updateRefRes.ok) throw Object.assign(new Error(`Failed to move ${branch}: ${(await ghJson(updateRefRes)).message || updateRefRes.status}`), { status: 502 });

  return { branch, commitSha: newCommit.sha, rolledBackToSha: targetSha, previousHeadSha: headSha };
}

// ── Pull requests (self-dev "push to a branch, auto-merge on green") ────────
// pushSelfDevToGithub.js's default path lands a change on a `self-dev/<ts>`
// branch and opens a PR instead of committing straight to main; mergeSelfDevPr.js
// then polls the PR's checks and squash-merges it once they pass. Branch
// protection / GitHub-native auto-merge isn't available on this repo (private,
// free plan), so Morpheus does the poll-and-merge itself with these helpers.

export async function createPullRequest(token, repoFullName, { head, base, title, body }) {
  const h = ghHeaders(token);
  const res = await fetch(`${GH_API}/repos/${repoFullName}/pulls`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ head, base, title, body }),
  });
  const data = await ghJson(res);
  if (!res.ok) {
    throw Object.assign(new Error(`Failed to open PR ${head} → ${base}: ${data.message || res.status}`), { status: res.status, details: data });
  }
  return { number: data.number, url: data.html_url, headSha: data.head?.sha, headRef: data.head?.ref };
}

// Combined check state for a PR: merges the Checks API (check-runs — GitHub
// Actions, Netlify) and the older commit-status API (some integrations still
// post there) into one verdict: 'merged' | 'failed' | 'pending' | 'passing'.
export async function getPullRequestChecks(token, repoFullName, prNumber) {
  const h = ghHeaders(token);
  const pr = await ghJson(await fetch(`${GH_API}/repos/${repoFullName}/pulls/${prNumber}`, { headers: h }));
  if (pr.merged) {
    return { state: 'merged', prNumber, mergedSha: pr.merge_commit_sha, headRef: pr.head?.ref };
  }
  const headSha = pr.head?.sha;
  const base = {
    prNumber, headSha, headRef: pr.head?.ref, createdAt: pr.created_at,
    mergeable: pr.mergeable, mergeableState: pr.mergeable_state,
  };
  if (!headSha) return { ...base, state: 'pending', checks: [] };

  const [checkRuns, status] = await Promise.all([
    ghJson(await fetch(`${GH_API}/repos/${repoFullName}/commits/${headSha}/check-runs`, { headers: h })),
    ghJson(await fetch(`${GH_API}/repos/${repoFullName}/commits/${headSha}/status`, { headers: h })),
  ]);

  const runs = checkRuns.check_runs || [];
  const OK = ['success', 'neutral', 'skipped'];
  const runsPending = runs.filter((r) => r.status !== 'completed');
  const runsFailed = runs.filter((r) => r.status === 'completed' && !OK.includes(r.conclusion));

  const statuses = status.statuses || [];
  const statusFailed = statuses.filter((s) => s.state === 'failure' || s.state === 'error');
  const statusPending = statuses.filter((s) => s.state === 'pending');

  const checks = [
    ...runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion })),
    ...statuses.map((s) => ({ name: s.context, status: s.state === 'pending' ? 'in_progress' : 'completed', conclusion: s.state === 'pending' ? null : s.state })),
  ];
  const totalChecks = runs.length + statuses.length;

  if (runsFailed.length || statusFailed.length) {
    return { ...base, state: 'failed', checks, failing: [...runsFailed.map((r) => r.name), ...statusFailed.map((s) => s.context)] };
  }
  if (runsPending.length || statusPending.length) {
    return { ...base, state: 'pending', checks };
  }
  return { ...base, state: 'passing', checks, noChecks: totalChecks === 0 };
}

export async function mergePullRequest(token, repoFullName, prNumber, { method = 'squash', commitTitle, commitMessage } = {}) {
  const h = ghHeaders(token);
  const res = await fetch(`${GH_API}/repos/${repoFullName}/pulls/${prNumber}/merge`, {
    method: 'PUT', headers: h,
    body: JSON.stringify({
      merge_method: method,
      ...(commitTitle ? { commit_title: commitTitle } : {}),
      ...(commitMessage ? { commit_message: commitMessage } : {}),
    }),
  });
  const data = await ghJson(res);
  if (!res.ok) {
    throw Object.assign(new Error(`Merge of PR #${prNumber} failed: ${data.message || res.status}`), { status: res.status, details: data });
  }
  return { merged: !!data.merged, mergeCommitSha: data.sha };
}

// Delete a branch ref. 204 = deleted, 422 = already gone — both fine for the
// "tidy up the merged self-dev branch" use.
export async function deleteBranch(token, repoFullName, branch) {
  const h = ghHeaders(token);
  const res = await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${branch}`, { method: 'DELETE', headers: h });
  return { ok: res.status === 204 || res.status === 422, status: res.status };
}

// List all repos owned by the authenticated user (paginated, 100/page, up to
// 2000 — comfortably above the 370 this account currently holds, and the loop
// exits early once a page comes back short). Used by cleanupBuildRepos.js to
// find the LEGACY morpheus-build-* repos the old per-attempt compile scheme
// left behind (repoName = `${prefix}${slug}-${Date.now()}`). compileProject.js
// no longer produces them — a project now reuses one persistent
// morpheus-project-* repo — so this only ever finds history now.
export async function listUserRepos(token) {
  const h = ghHeaders(token);
  const repos = [];
  for (let page = 1; page <= 20; page++) { // 20 * 100 = 2000 repos, a generous ceiling
    const res = await fetch(`${GH_API}/user/repos?per_page=100&page=${page}&affiliation=owner`, { headers: h });
    if (!res.ok) {
      const err = await ghJson(res);
      throw new Error(`Failed to list repos (HTTP ${res.status}, page ${page}): ${err.message || JSON.stringify(err)}`);
    }
    const batch = await ghJson(res);
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

// Permanently delete a repo the user owns. Requires the `delete_repo` OAuth
// scope -- `repo` alone is not enough, GitHub carves deletion out separately
// even though `repo` otherwise grants full control (see connections.routes.js
// for where this scope gets requested). A connection made before that scope
// was added will get a 403 here with a message telling the user to
// reconnect; that 403 is passed through as-is rather than swallowed, so the
// caller (cleanupBuildRepos.js) can surface it clearly instead of pretending
// the delete succeeded.
export async function deleteRepo(token, repoFullName) {
  const h = ghHeaders(token);
  const res = await fetch(`${GH_API}/repos/${repoFullName}`, { method: 'DELETE', headers: h });
  if (res.status === 204) return { ok: true };
  const err = await ghJson(res).catch(() => ({}));
  return { ok: false, status: res.status, error: err.message || `HTTP ${res.status}` };
}

// ── Self-dev push helpers (added by the 2026-09-06 self-dev rewrite of this
// file, restored here 2026-09-08 alongside everything above rather than
// dropped -- see getGithubConnection's comment for the full story) ─────────
// pushSelfDevToGithub.js diffs the local self-dev workspace against the real
// repo's tree and pushes only what changed, one Contents-API call per file,
// rather than compileProject.js's blob/tree/commit batch approach above --
// appropriate for self-dev's usual small, incremental change sets.

// Fetch the full recursive tree for a branch, returning only blobs.
// Each entry: { path, sha, mode }
export async function fetchRemoteTree(owner, repo, branch, token) {
  const h = ghHeaders(token);
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { headers: h });
  const data = await ghJson(res);
  if (!res.ok) {
    const err = new Error(data.message || `GitHub API ${res.status}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return (data.tree || [])
    .filter((entry) => entry.type === 'blob')
    .map((entry) => ({ path: entry.path, sha: entry.sha, mode: entry.mode || '100644' }));
}

// Read one file via the Contents API. Returns { content, sha, size } with
// content decoded to a UTF-8 string, or null if the path doesn't exist.
// Files up to 1MB come back inline (bigger ones would need the blob API --
// not a concern for the content/*.json the CMS panel edits).
export async function getFileContent(owner, repo, path, branch, token) {
  const h = ghHeaders(token);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, { headers: h });
  if (res.status === 404) return null;
  const data = await ghJson(res);
  if (!res.ok) {
    const err = new Error(data.message || `GitHub API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (Array.isArray(data) || data.type !== 'file') return null; // a directory
  const content = data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf-8') : (data.content || '');
  return { content, sha: data.sha, size: data.size };
}

// Create or update a single file via the Contents API. `content` may be a
// Buffer (binary) or a string (text) -- both base64-encode the same way.
// `sha` is required when updating an existing path, omitted when creating.
export async function createOrUpdateFile(owner, repo, path, content, branch, token, message, sha) {
  const h = ghHeaders(token);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const body = {
    message,
    content: Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content, 'utf-8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodedPath}`, {
    method: 'PUT', headers: h, body: JSON.stringify(body),
  });
  const data = await ghJson(res);
  if (!res.ok) {
    const err = new Error(data.message || `GitHub API ${res.status}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

// Delete a single file via the Contents API. `sha` (the file's current blob
// sha) is required by GitHub's delete endpoint to avoid racing a concurrent
// edit.
export async function deleteFile(owner, repo, path, branch, sha, token, message) {
  const h = ghHeaders(token);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodedPath}`, {
    method: 'DELETE', headers: h, body: JSON.stringify({ message, branch, sha }),
  });
  const data = await ghJson(res);
  if (!res.ok) {
    const err = new Error(data.message || `GitHub API ${res.status}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
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
