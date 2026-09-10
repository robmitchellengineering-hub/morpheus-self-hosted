// Shared engine — SHIP. Diff a project's files against a GitHub repo and
// push the delta: either straight to the base branch, or onto a throwaway
// branch with a PR opened against it. Host-agnostic for any GitHub-repo
// target (self-dev today; a static-site plugin tenant later — the WordPress
// adapter's own "ship" is the webhook + PHP write, a different path).
//
// How it decides what to push:
//   1. Diff the given files against the remote git tree by git-blob SHA, so
//      an unchanged file is never re-pushed and "no changes" is a real,
//      cheap answer.
//   2. Deletions: a remote path absent from `files` counts as a deletion
//      only if `exclude(path)` is false — a caller that mirrors a subset of
//      the repo must not have the rest seen as "deleted". Skipped entirely
//      when GitHub truncated the tree (our view is then incomplete).
//   3. Everything goes out as ONE commit (fetch tree → merge changes + drop
//      deletions → single commit → single ref update).
import { pushFiles, createPullRequest } from '../github.js';
import { gitBlobSha } from '../selfDevRepo.js';

const GH_API = 'https://api.github.com';

function ghHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Morpheus' };
}

function diffLine({ createCount, updateCount, deleteCount, treeTruncated }) {
  return [
    createCount && `${createCount} new`,
    updateCount && `${updateCount} changed`,
    deleteCount && `${deleteCount} deleted`,
    treeTruncated && 'deletions skipped (remote tree truncated)',
  ].filter(Boolean).join(', ');
}

/**
 * @param {string} token
 * @param {string} repoFullName  "owner/repo"
 * @param {object} opts
 * @param {{path:string, content:string}[]} opts.files
 * @param {(path:string)=>boolean} [opts.exclude]
 * @param {string} [opts.baseBranch]      default "main"
 * @param {string} [opts.branchPrefix]    PR-mode branch name prefix, default "change/"
 * @param {boolean} [opts.directToMain]   commit straight to baseBranch
 * @param {string} [opts.label]           commit / PR title prefix, default "Change"
 * @param {string} [opts.prNote]          an extra bullet in the default PR body
 * @param {string} [opts.prBody]          full PR body override (ignores prNote)
 * @param {(cs:{changedPaths:string[],deletePaths:string[],createCount:number,updateCount:number})=>(object|null|Promise<object|null>)} [opts.precheck]
 *        run after the diff, before the push; a non-null return blocks the
 *        ship and is spread into { shipped: false, ...return }
 * @returns {Promise<object>}  see the block comment above for the shapes
 */
export async function shipChange(token, repoFullName, opts) {
  const {
    files, exclude = () => false, baseBranch = 'main',
    branchPrefix = 'change/', directToMain = false, label = 'Change', prNote, prBody, precheck,
  } = opts;

  const [owner, repo] = repoFullName.split('/');
  const treeRes = await fetch(`${GH_API}/repos/${owner}/${repo}/git/trees/${baseBranch}?recursive=1`, { headers: ghHeaders(token) });
  if (!treeRes.ok) {
    const err = await treeRes.json().catch(() => ({}));
    throw Object.assign(new Error(`Failed to read ${repoFullName} tree: ${err.message || treeRes.status}`), { status: 502 });
  }
  const treeData = await treeRes.json();
  const remoteAll = new Map();
  for (const e of treeData.tree || []) {
    if (e.type === 'blob') remoteAll.set(e.path, e.sha);
  }
  const treeTruncated = !!treeData.truncated;

  const localPaths = new Set(files.map((f) => f.path));
  const changed = [];
  for (const f of files) {
    if (exclude(f.path)) continue;
    const remoteSha = remoteAll.get(f.path);
    if (!remoteSha || remoteSha !== gitBlobSha(f.content ?? '')) {
      changed.push({ path: f.path, content: f.content ?? '' });
    }
  }

  const deletePaths = [];
  if (!treeTruncated) {
    for (const remotePath of remoteAll.keys()) {
      if (exclude(remotePath)) continue;
      if (!localPaths.has(remotePath)) deletePaths.push(remotePath);
    }
  }

  const createCount = changed.filter((c) => !remoteAll.has(c.path)).length;
  const updateCount = changed.length - createCount;
  const deleteCount = deletePaths.length;
  const changedPaths = changed.map((c) => c.path);

  if (changed.length === 0 && deleteCount === 0) {
    return { shipped: false, reason: 'no-changes', createCount: 0, updateCount: 0, deleteCount: 0, changedPaths: [], treeTruncated };
  }

  if (typeof precheck === 'function') {
    const block = await precheck({ changedPaths, deletePaths, createCount, updateCount });
    if (block) return { shipped: false, ...block };
  }

  const summary = diffLine({ createCount, updateCount, deleteCount, treeTruncated });
  const commitMessage = `${label}: ${summary} (via Morpheus)`;
  const counts = { createCount, updateCount, deleteCount, changedPaths, summary, treeTruncated };

  if (directToMain) {
    const { branch, commitSha } = await pushFiles(token, repoFullName, changed, commitMessage, { isNewRepo: false, deletePaths });
    return {
      shipped: true, mode: 'direct', branch, commitSha,
      commitUrl: `https://github.com/${repoFullName}/commit/${commitSha}`,
      ...counts,
    };
  }

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const prBranch = `${branchPrefix}${ts}`;
  const { commitSha } = await pushFiles(token, repoFullName, changed, commitMessage, {
    isNewRepo: false, deletePaths, targetBranch: prBranch, baseBranch,
  });
  const pr = await createPullRequest(token, repoFullName, {
    head: prBranch,
    base: baseBranch,
    title: `${label}: ${summary}`,
    body: prBody || [
      `Automated change via Morpheus.`,
      '',
      `- ${createCount} new, ${updateCount} changed, ${deleteCount} deleted`,
      ...(prNote ? [`- ${prNote}`] : []),
      '',
      "Morpheus is polling this PR's checks and will squash-merge it once they're green. If a check fails, the base branch is left untouched.",
    ].join('\n'),
  });

  return {
    shipped: true, mode: 'pr', branch: prBranch, headSha: commitSha,
    prNumber: pr.number, prUrl: pr.url,
    ...counts,
  };
}
