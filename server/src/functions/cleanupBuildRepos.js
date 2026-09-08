// Batch-deletes the throwaway GitHub repos compileProject.js creates on
// every compile attempt (repoName = `${prefix}${slug}-${Date.now()}`, see
// that file) -- each compile, including every automatic retry in
// CompilePanel.jsx's fix loop, spins a brand-new timestamped repo that is
// never reused and never cleaned up on its own. Rob asked for "a github cli
// automated interface to batch delete all the old repos that get created
// trying to compile" -- this is that, exposed as a Morpheus function instead
// of a local CLI so it works from any device without local GitHub creds,
// using the same OAuth connection compileProject.js already has.
//
// Safety model: rather than trying to track which repo is "the current one"
// for each project (nothing in the schema records that -- see the Prisma
// model, compile repo names only ever get returned to the frontend, not
// persisted), this only ever considers repos matching the build-repo prefix
// AND older than `olderThanHours` (default 24, min enforced at 1). A compile
// run finishes (success or failure, including all 10 of the auto fix-loop's
// retries) in minutes, so anything past that window is safe to assume is
// done with. Defaults to dry-run (list + count, no deletion) unless the
// caller explicitly passes { confirm: true }, matching the two-step
// preview-then-delete flow in ConnectionsDialog.jsx.
import { getGithubToken, getGhUser, listUserRepos, deleteRepo } from '../lib/github.js';

const DEFAULT_PREFIX = process.env.COMPILE_BUILD_REPO_PREFIX || 'morpheus-build-';
const MIN_AGE_HOURS = 1; // floor, so a compile that's still mid-run can never be swept up

export default async function handler({ user, body, res }) {
  const prefix = typeof body.prefix === 'string' && body.prefix.trim() ? body.prefix.trim() : DEFAULT_PREFIX;
  const olderThanHours = Math.max(MIN_AGE_HOURS, Number(body.olderThanHours) || 24);
  const confirm = body.confirm === true;
  const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;

  const accessToken = await getGithubToken(user.id);

  const ghUser = await getGhUser(accessToken);
  if (!ghUser?.login) {
    res.status(502).json({ error: 'Could not verify the connected GitHub account (GitHub API did not return a login).' });
    return;
  }

  let allRepos;
  try {
    allRepos = await listUserRepos(accessToken);
  } catch (err) {
    res.status(502).json({ error: `Failed to list repos from GitHub: ${err.message}` });
    return;
  }

  const candidates = allRepos
    .filter((r) => r.name && r.name.startsWith(prefix))
    .filter((r) => new Date(r.created_at).getTime() < cutoff)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (!confirm) {
    return {
      dryRun: true,
      prefix,
      olderThanHours,
      count: candidates.length,
      repos: candidates.map((r) => ({ name: r.name, fullName: r.full_name, htmlUrl: r.html_url, createdAt: r.created_at })),
    };
  }

  const deleted = [];
  const failed = [];
  for (const repo of candidates) {
    const result = await deleteRepo(accessToken, repo.full_name);
    if (result.ok) {
      deleted.push(repo.full_name);
    } else {
      failed.push({ repo: repo.full_name, status: result.status, error: result.error });
    }
    // GitHub's secondary rate limiter targets bursts of same-type requests
    // (compileProject.js's createRepo comments document the same limiter
    // hitting repo creation) -- a small pause between deletes avoids
    // tripping it when there are dozens of repos to clean up in one pass.
    await new Promise((r) => setTimeout(r, 300));
  }

  // A run of all-403s almost always means the connection predates the
  // delete_repo scope addition (see connections.routes.js) rather than N
  // separate real permission problems -- surface that once, clearly,
  // instead of making the user read 40 identical error lines.
  const allForbidden = failed.length > 0 && deleted.length === 0 && failed.every((f) => f.status === 403);

  return {
    dryRun: false,
    prefix,
    olderThanHours,
    attempted: candidates.length,
    deletedCount: deleted.length,
    deleted,
    failed,
    hint: allForbidden
      ? 'All deletes were rejected with 403. Your GitHub connection was likely made before delete_repo was added to the requested scope -- disconnect and reconnect GitHub in Connections, then try again.'
      : undefined,
  };
}
