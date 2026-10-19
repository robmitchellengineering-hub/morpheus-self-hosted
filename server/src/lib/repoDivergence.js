// The GitHub half of the divergence check: read the linked repo's tree and ask
// lib/projectDivergence.js whether either side has moved since the last sync.
//
// Everything here is best-effort BY DESIGN. A missing repo, a missing token, an
// API failure, an unreadable response or a truncated tree all return state
// 'unknown', and a caller must then behave exactly as it did before this check
// existed (KNOWN-HAZARDS.md H17: a check that cannot answer must never claim
// divergence, and must never narrow what the loop can do). The only path that
// returns anything other than 'unknown' from this file is one where both file
// lists are in hand and comparable.
//
// The incremental shape is the same one syncProjectFromGithub.js uses: a blob
// whose git sha already matches the construct's copy is identical by definition,
// so it is never fetched. Only genuinely differing files cost an API call.
import { getGithubToken, ghHeaders, ghJson } from './github.js';
import { gitBlobSha } from './selfDevRepo.js';
import { assessDivergence, unknownDivergence, shouldComparePath } from './projectDivergence.js';

const GH_API = 'https://api.github.com';

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Assess divergence between `project`'s linked GitHub repo and `constructFiles`.
 *
 * `constructFiles` is the already-loaded project file list ([{ path, content }])
 * — the callers have it, so this never reads the database.
 *
 * Always returns the pure module's `{ state, ahead, behind, reason }`, plus
 * `repoFullName`/`branch` when the repo was actually reached. Never throws.
 */
export async function assessProjectDivergence({ userId, project, constructFiles } = {}) {
  try {
    if (!project?.github_repo) return unknownDivergence('no-linked-repo');
    if (!Array.isArray(constructFiles)) return unknownDivergence('unusable-input');

    let accessToken;
    try {
      accessToken = await getGithubToken(userId, { projectId: project.id });
    } catch {
      return unknownDivergence('no-token');
    }
    const h = ghHeaders(accessToken);

    const repoRes = await fetch(`${GH_API}/repos/${project.github_repo}`, { headers: h });
    if (!repoRes.ok) return unknownDivergence('github-api-error');
    const repoInfo = await ghJson(repoRes);
    const branch = repoInfo?.default_branch || 'main';

    const treeRes = await fetch(`${GH_API}/repos/${project.github_repo}/git/trees/${branch}?recursive=1`, { headers: h });
    if (!treeRes.ok) return unknownDivergence('github-api-error');
    const tree = await ghJson(treeRes);
    // An unreadable body, a partial tree, and an empty repo's 409 all resolve to
    // "we cannot see the whole repo" — never to a clean bill of health.
    if (!tree || !Array.isArray(tree.tree)) return unknownDivergence('github-api-error');
    if (tree.truncated) return unknownDivergence('tree-truncated');

    const blobs = tree.tree.filter((item) => item.type === 'blob' && shouldComparePath(item.path));
    const construct = constructFiles.filter((f) => shouldComparePath(f?.path));
    const constructSha = new Map(construct.map((f) => [f.path, gitBlobSha(f.content)]));
    const constructContent = new Map(construct.map((f) => [f.path, f.content ?? '']));

    const toFetch = blobs.filter((item) => constructSha.get(item.path) !== item.sha);
    const fetched = await mapWithConcurrency(toFetch, 10, async (item) => {
      try {
        const res = await fetch(`${GH_API}/repos/${project.github_repo}/git/blobs/${item.sha}`, { headers: h });
        if (!res.ok) return null;
        const blob = await ghJson(res);
        if (!blob) return null;
        if (blob.encoding === 'base64') {
          return { path: item.path, content: Buffer.from(blob.content || '', 'base64').toString('utf8') };
        }
        if (typeof blob.content !== 'string') return null;
        return { path: item.path, content: blob.content };
      } catch {
        return null;
      }
    });
    // One unreadable blob is enough to make the whole comparison unsound: the
    // file it belongs to might be the divergent one. Report 'unknown' instead.
    if (fetched.some((f) => f === null)) return unknownDivergence('blob-fetch-failed');
    const fetchedByPath = new Map(fetched.map((f) => [f.path, f.content]));

    const repoFiles = blobs.map((item) => ({
      path: item.path,
      // A matching git sha means the bytes are identical, so the construct's own
      // copy IS the repo's copy — no fetch needed.
      content: fetchedByPath.has(item.path) ? fetchedByPath.get(item.path) : (constructContent.get(item.path) ?? ''),
    }));

    const assessment = assessDivergence({ repoFiles, constructFiles });
    return { ...assessment, repoFullName: project.github_repo, branch };
  } catch {
    return unknownDivergence('github-api-error');
  }
}
