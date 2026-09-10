// Browse the WordPress site's connected GitHub repo and pull individual
// files / folders into the Morpheus project, so the coder can actually see
// and edit the theme (a full WP install is ~27k files — you import the 20-50
// you work with, not the lot). Paired with the WP-aware coder context.
//
// Actions:
//   tree     { dir? }        — immediate children of a directory (lazy browse)
//   import   { paths: [] }   — fetch those files/folders → ProjectFile rows
//   imported                 — which repo files are currently in the project
//   remove   { paths: [] }   — drop those ProjectFile rows
import { prisma } from '../db.js';
import { getGithubToken, ghHeaders, ghJson, getFileContent } from '../lib/github.js';
import { getWpConnection } from '../lib/wpPlugin.js';
import { detectLanguage, logUsage } from '../lib/projectUtils.js';
import { PLUGIN_DENY_PATHS } from '../lib/enginePolicy.js';

const GH_API = 'https://api.github.com';
const MAX_IMPORT_PER_CALL = 200;
const MAX_PROJECT_FILES = 600;
const MAX_FILE_BYTES = 256 * 1024;

// WordPress core + anything vendored — never worth importing or editing.
const SKIP_DIR = /^(wp-admin|wp-includes)\//i;
const SKIP_RE = /(^|\/)(node_modules|vendor|\.git)\/|\.(png|jpe?g|gif|ico|svg|webp|woff2?|ttf|eot|otf|mp[34]|mov|zip|gz|tar|pdf|min\.(js|css)|map|mo|po|pot)$/i;
const isSkippable = (p) => SKIP_DIR.test(p) || SKIP_RE.test(p);
const isDenied = (p) => PLUGIN_DENY_PATHS.some((re) => re.test(p));

// In-memory cache of the flat repo tree, keyed by repo@branch (5 min).
const treeCache = new Map();
async function loadTree(repo, branch, token) {
  const key = `${repo}@${branch}`;
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.entries;
  const [owner, name] = repo.split('/');
  const res = await fetch(`${GH_API}/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers: ghHeaders(token) });
  const data = await ghJson(res);
  if (!res.ok) throw Object.assign(new Error(`Couldn't read ${repo} — ${data.message || res.status}`), { status: 502 });
  const entries = (data.tree || [])
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: e.path, sha: e.sha, size: e.size || 0 }));
  treeCache.set(key, { entries, at: Date.now(), truncated: !!data.truncated });
  return entries;
}

async function resolve(projectId, userId) {
  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: userId } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  const conn = await getWpConnection(projectId, userId);
  const repo = conn?.repo || project.github_repo || null;
  if (!repo) {
    throw Object.assign(new Error('No GitHub repo connected — set the repo in the plugin (Settings → Morpheus) or Export to GitHub.'), { status: 400 });
  }
  const meta = conn?.meta && typeof conn.meta === 'object' ? conn.meta : {};
  return { project, repo, branch: meta.branch || 'main', token: await getGithubToken(userId) };
}

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  const action = body?.action || query?.action || 'tree';
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const { project, repo, branch, token } = await resolve(projectId, user.id);

  if (action === 'tree') {
    const dir = (body?.dir || query?.dir || '').replace(/^\/+|\/+$/g, '');
    const prefix = dir ? dir + '/' : '';
    const entries = await loadTree(repo, branch, token);
    const dirs = new Map();
    const files = [];
    for (const e of entries) {
      if (!e.path.startsWith(prefix)) continue;
      const rest = e.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        files.push({ name: rest, path: e.path, size: e.size, skippable: isSkippable(e.path), denied: isDenied(e.path) });
      } else {
        const name = rest.slice(0, slash);
        const full = prefix + name;
        if (!dirs.has(name)) dirs.set(name, { name, path: full, skippable: isSkippable(full + '/') });
      }
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    return { repo, branch, dir, dirs: [...dirs.values()].sort(byName), files: files.sort(byName) };
  }

  if (action === 'imported') {
    const entries = await loadTree(repo, branch, token);
    const repoPaths = new Set(entries.map((e) => e.path));
    const rows = await prisma.projectFile.findMany({
      where: { project_id: projectId }, select: { path: true, content: true },
    });
    return {
      repo, branch,
      files: rows
        .filter((r) => repoPaths.has(r.path))
        .map((r) => ({ path: r.path, bytes: Buffer.byteLength(r.content || '', 'utf8') }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      otherCount: rows.filter((r) => !repoPaths.has(r.path)).length,
    };
  }

  if (action === 'remove') {
    const paths = (body?.paths || []).filter((p) => typeof p === 'string');
    if (!paths.length) throw Object.assign(new Error('paths required'), { status: 400 });
    const { count } = await prisma.projectFile.deleteMany({ where: { project_id: projectId, path: { in: paths } } });
    return { removed: count };
  }

  if (action === 'import') {
    const wanted = (body?.paths || []).filter((p) => typeof p === 'string' && p.trim());
    if (!wanted.length) throw Object.assign(new Error('paths required'), { status: 400 });

    const entries = await loadTree(repo, branch, token);
    // Expand any directory selections to their files.
    const chosen = new Set();
    for (const w of wanted) {
      const clean = w.replace(/^\/+|\/+$/g, '');
      for (const e of entries) {
        if (e.path === clean || e.path.startsWith(clean + '/')) chosen.add(e.path);
      }
    }
    const importable = [...chosen].filter((p) => {
      const e = entries.find((x) => x.path === p);
      return e && !isSkippable(p) && !isDenied(p) && e.size <= MAX_FILE_BYTES;
    });

    const existing = await prisma.projectFile.count({ where: { project_id: projectId } });
    const room = Math.max(0, MAX_PROJECT_FILES - existing);
    const toGet = importable.slice(0, Math.min(MAX_IMPORT_PER_CALL, room || MAX_IMPORT_PER_CALL));

    const [owner, name] = repo.split('/');
    let imported = 0, updated = 0, failed = 0;
    for (const path of toGet) {
      try {
        const file = await getFileContent(owner, name, path, branch, token);
        if (file == null) { failed++; continue; }
        const row = await prisma.projectFile.findFirst({ where: { project_id: projectId, path } });
        if (row) {
          await prisma.projectFile.update({ where: { id: row.id }, data: { content: file.content } });
          updated++;
        } else {
          await prisma.projectFile.create({
            data: { project_id: projectId, created_by_id: user.id, path, content: file.content, language: detectLanguage(path) },
          });
          imported++;
        }
      } catch { failed++; }
    }

    await logUsage(user.id, 'repo_files_import', projectId, project.name, { repo, imported, updated });
    return {
      imported, updated, failed,
      skipped: importable.length - toGet.length,
      total: existing + imported,
      cap: MAX_PROJECT_FILES,
      note: importable.length > toGet.length
        ? `Imported ${toGet.length} — ${importable.length - toGet.length} more matched. Import again or narrow the selection (${MAX_PROJECT_FILES}-file project cap).`
        : null,
    };
  }

  throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
}
