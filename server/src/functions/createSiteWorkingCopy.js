// Create a GitHub working copy of a live site's active theme.
//
// WHY THIS EXISTS
//
// Every code path in Morpheus — the build loop, deploy, PR review — assumes the
// site's theme lives in a GitHub repo. Until now the operator had to bring one:
// create the repo, copy the files in, set a token, point the plugin at it. For
// a site someone else built, that is where it stopped.
//
// This does it for them: it asks the plugin for the active theme's text files,
// creates a private repo, commits them in ONE commit, and records the repo on
// the connection so Deploy/Code work immediately afterwards.
//
// WHAT IT DOES NOT DO
//
//   * Binary files (images, fonts, archives) are not copied. A deploy only ever
//     touches files a commit changed, so a repo without the media is a complete
//     working copy for code and nothing will delete them from the site. The
//     summary says exactly how many were skipped, so it is never a silent gap.
//   * Nothing is overwritten blindly: if the repo name is taken, the same
//     commit is attempted on top (pushFiles handles that), and the response
//     says which happened.
//   * A site with no plugin v0.5.5+ is told to update rather than half-copied.
import { prisma } from '../db.js';
import { getWpConnection, wpExportThemeTree, wpExportThemeFiles } from '../lib/wpPlugin.js';
import { getGithubToken, getGithubLogin, createRepo, pushFiles, listUserRepos } from '../lib/github.js';
import { logUsage } from '../lib/projectUtils.js';
import { repoNameForSite } from '../lib/siteWorkingCopy.js';

// How many files to pull per round trip, and how many round trips at most. The
// plugin caps a batch at 200 files / 4MB; this is the client-side guard so a
// pathological theme can't cause an unbounded number of requests.
const BATCH_ROUNDS = 30;

export default async function handler({ user, body }) {
  const { projectId } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) throw Object.assign(new Error('Connect your site first (SETUP tab).'), { status: 400 });

  // The user's GitHub account — this repo is theirs, in their account, under
  // their control. getGithubToken throws a clear "connect GitHub" error.
  const token = await getGithubToken(user.id);
  const login = await getGithubLogin(user.id).catch(() => null);

  // 1. What is on the site?
  const tree = await wpExportThemeTree(conn);
  if (tree.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${tree.error || 'no response'}`), { status: 502 });
  }
  // TWO SHAPES OF "TOO OLD", and both were found by pointing this at a real
  // older plugin rather than by reading the code:
  //   * the /export ROUTE does not exist at all  -> WordPress 404 rest_no_route
  //   * the route exists but not this action     -> 400 unknown_action
  // The first version only handled the second, so a site on an older build got
  // WordPress's raw "No route was found matching the URL and request method."
  const noRoute = tree.status === 404
    && /rest_no_route|no route was found/i.test(`${tree.data?.code || ''} ${tree.data?.message || ''} ${tree.data?.error || ''}`);
  const unknownAction = tree.status === 400 && tree.data?.error === 'unknown_action';
  if (noRoute || unknownAction) {
    const running = conn.meta?.version ? ` (this site runs v${conn.meta.version})` : '';
    throw Object.assign(new Error(`This site's Morpheus plugin is too old to export its theme${running} — it needs v0.5.5 or newer. Update it from your WordPress Plugins screen (one tap) and try again.`), { status: 409 });
  }
  if (!tree.ok || !tree.data?.ok) {
    throw Object.assign(new Error(tree.data?.message || tree.data?.error || 'The site would not list its theme files.'), { status: 502 });
  }

  const theme = tree.data.theme || {};
  const manifest = Array.isArray(tree.data.files) ? tree.data.files : [];
  if (manifest.length === 0) {
    throw Object.assign(new Error('That site\'s active theme has no readable text files — nothing to copy.'), { status: 422 });
  }

  // 2. Pull the contents, in batches, verifying each against the hash the
  //    manifest gave. A file that changes under us (a live edit, a cache write)
  //    is reported rather than committed as something nobody has seen.
  const files = [];
  const mismatched = [];
  let guard = 0;
  for (let i = 0; i < manifest.length && guard < BATCH_ROUNDS; guard++) {
    const batch = manifest.slice(i, i + 200);
    i += batch.length;
    // eslint-disable-next-line no-await-in-loop
    const res = await wpExportThemeFiles(conn, batch.map((f) => f.path));
    if (res.status === 0) {
      throw Object.assign(new Error(`The site stopped answering while reading ${batch[0]?.path || 'its theme'} — try again.`), { status: 502 });
    }
    if (!res.ok || !res.data?.ok) {
      throw Object.assign(new Error(res.data?.message || 'The site refused to send its theme files.'), { status: 502 });
    }
    const got = Array.isArray(res.data.files) ? res.data.files : [];
    for (const f of got) {
      const expected = batch.find((b) => b.path === f.path);
      if (expected?.hash && f.hash && expected.hash !== f.hash) {
        // Changed since the listing — take the bytes but say so.
        mismatched.push(f.path);
      }
      files.push({ path: f.path, content: f.content });
    }
    if (i >= manifest.length) break;
  }

  if (files.length === 0) {
    throw Object.assign(new Error('None of the theme\'s files could be read — try again.'), { status: 502 });
  }

  // 3. Which repo? Prefer the site's own name so the operator recognises it,
  //    and never collide with something they already have. A caller may ask for
  //    a specific name (naming conventions vary, and it makes the flow
  //    scriptable) — validated here rather than trusted, because it becomes a
  //    GitHub path.
  const requested = typeof body?.repoName === 'string' ? body.repoName.trim() : '';
  if (requested && !/^[A-Za-z0-9._-]{1,90}$/.test(requested)) {
    throw Object.assign(new Error('A repository name can only contain letters, numbers, dots, dashes and underscores.'), { status: 400 });
  }
  if (requested === '.' || requested === '..') {
    throw Object.assign(new Error('That is not a usable repository name.'), { status: 400 });
  }
  const desired = requested || repoNameForSite(conn.siteUrl, project.name);
  let repoName = desired;
  let reused = false;
  try {
    const mine = await listUserRepos(token);
    const taken = new Set((Array.isArray(mine) ? mine : []).map((r) => (r.name || '').toLowerCase()));
    if (taken.has(repoName.toLowerCase())) {
      reused = true; // pushFiles merges onto it rather than destroying it
    }
  } catch { /* listing is a nicety; creation below is the real check */ }

  const repo = await createRepo(token, repoName, true, { autoInit: false });
  if (!repo || !repo.full_name) {
    throw Object.assign(new Error('GitHub would not create the repository — check your GitHub connection and try again.'), { status: 502 });
  }
  if (repo._isNewRepo === false && !reused) reused = true;

  // 4. One commit for the whole copy, plus a README that explains what this
  //    repo is — the first thing anyone opening it will read.
  const readme = [
    `# ${theme.name || repoName}`,
    '',
    `A working copy of the WordPress theme on **${conn.siteUrl.replace(/^https?:\/\//, '')}**, created by Morpheus.`,
    '',
    `- Site: ${conn.siteUrl}`,
    `- Theme: ${theme.name || theme.slug}${theme.version ? ` v${theme.version}` : ''}${theme.is_child ? ` (child theme; its parent \`${theme.parent_slug}\` is not copied)` : ''}`,
    `- Files: ${files.length} text file${files.length === 1 ? '' : 's'}`,
    '',
    '## How changes reach the site',
    '',
    'Morpheus opens a pull request against this repo. When its checks pass and you merge it,',
    'the Morpheus plugin on the site applies exactly the files that commit changed, health-checks',
    'the site and rolls back if anything breaks. Nothing is edited on the server directly.',
    '',
    '## What is not here',
    '',
    'Images, fonts and other binary files are not copied — Morpheus manages code, and WordPress',
    'keeps serving those from the site itself. WordPress core, other plugins and any parent theme',
    'are deliberately absent: a deploy must never touch them.',
    '',
  ].join('\n');

  const pushed = await pushFiles(
    token,
    repo.full_name,
    [...files, { path: 'README-MORPHEUS.md', content: readme }],
    `Working copy of ${theme.name || theme.slug} from ${conn.siteUrl.replace(/^https?:\/\//, '')}`,
    { isNewRepo: repo._isNewRepo },
  );

  const commitSha = pushed?.commitSha || null;

  // 5. Record the repo where everything else already looks for it: the plugin
  //    connection (what the deploy adapter reads) and the project (what the
  //    Media Library and compile flow use).
  await prisma.$transaction([
    prisma.pluginConnection.update({
      where: { id: conn.id },
      data: { repo: repo.full_name },
    }),
    prisma.project.update({ where: { id: projectId }, data: { github_repo: repo.full_name } }),
  ]);

  await logUsage(user.id, 'wp_working_copy', projectId, project.name, {
    repo: repo.full_name, files: files.length, reused,
  });

  return {
    ok: true,
    repo: repo.full_name,
    owner: login || repo.owner?.login || null,
    url: repo.html_url,
    reused,
    branch: pushed?.branch || repo.default_branch || 'main',
    commit: commitSha,
    files: files.length,
    bytes: manifest.reduce((n, f) => n + (f.size || 0), 0),
    theme: {
      slug: theme.slug || null,
      name: theme.name || null,
      is_child: !!theme.is_child,
      parent_slug: theme.parent_slug || null,
    },
    // Everything the operator should know about what is NOT in the repo.
    skipped: (tree.data.skipped || []).slice(0, 50),
    skipped_count: tree.data.skipped_count || 0,
    truncated: !!tree.data.truncated,
    changed_while_copying: mismatched.slice(0, 20),
    next: 'Use the CODE tab to pull these files into the project, then DEPLOY to ship a change.',
  };
}
