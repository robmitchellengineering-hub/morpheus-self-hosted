// The context block handed to the planner + coder when a project is
// connected to a live WordPress site (has a PluginConnection). It tells them
// they're editing a WordPress theme inside a real install — not building a
// standalone app — and spells out what must never be touched. Paired with
// the WEBSITE panel's CODE tab (which pulls the theme files in) and the
// `wordpress` delivery adapter (which ships them).
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getGithubToken, ghHeaders, ghJson, getFileContent } from './github.js';
import { detectLanguage } from './projectUtils.js';
import { PLUGIN_DENY_PATHS } from './enginePolicy.js';

const GH_API = 'https://api.github.com';
const IMPORTABLE_DIR = /^wp-content\/(themes|mu-plugins)\//;
const NON_TEXT = /\.(png|jpe?g|gif|ico|svg|webp|woff2?|ttf|eot|otf|mp[34]|mov|zip|gz|tar|pdf|min\.(js|css)|map|mo|po|pot)$/i;

// Before a build turn on a WordPress-connected project, look at what the
// operator asked for and pull the theme files a coder would need straight
// from the connected repo (they only have what was hand-imported in the
// CODE tab otherwise). Best-effort — the caller wraps this in try/catch, it
// never blocks chat.
export async function ensureWpFiles({ user, project, wpConn, message }) {
  const repo = wpConn?.repo || project.github_repo;
  if (!repo || !message) return { added: 0, paths: [] };
  const meta = wpConn?.meta && typeof wpConn.meta === 'object' ? wpConn.meta : {};
  const branch = meta.branch || 'main';

  const have = new Set((await prisma.projectFile.findMany({
    where: { project_id: project.id }, select: { path: true },
  })).map((r) => r.path));

  // If a substantial theme set is already imported, the normal scoped-context
  // research pass will pick what's relevant — don't spend a tree fetch + an
  // LLM call every turn.
  const themeFilesHeld = [...have].filter((p) => /^wp-content\/themes\//.test(p)).length;
  if (themeFilesHeld >= 30) return { added: 0, paths: [] };

  const token = await getGithubToken(user.id);
  const [owner, name] = repo.split('/');
  const res = await fetch(`${GH_API}/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers: ghHeaders(token) });
  const data = await ghJson(res);
  if (!res.ok) return { added: 0, paths: [] };

  const candidates = (data.tree || [])
    .filter((e) => e.type === 'blob'
      && IMPORTABLE_DIR.test(e.path)
      && !NON_TEXT.test(e.path)
      && (e.size || 0) <= 256 * 1024
      && !have.has(e.path)
      && !PLUGIN_DENY_PATHS.some((re) => re.test(e.path)))
    .map((e) => e.path)
    .slice(0, 1500);
  if (candidates.length === 0) return { added: 0, paths: [] };

  const { result } = await invokeAI({
    userId: user.id,
    role: 'planner',
    maxTokens: 900,
    prompt: `A WordPress site's theme files are in a repo. The operator wants a change made — pick ONLY the files a coder must see to make it (templates, functions.php, the stylesheet, template parts, relevant JS). Prefer the child theme. 0 to 12 paths.

OPERATOR WANTS:
${message}

REPO THEME FILES NOT YET IN THE PROJECT (${candidates.length}):
${candidates.join('\n')}

Return JSON: { "paths": ["exact paths from the list above"] }`,
    schema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
  });

  const want = (Array.isArray(result.paths) ? result.paths : [])
    .filter((p) => candidates.includes(p)).slice(0, 12);

  const added = [];
  for (const path of want) {
    try {
      const file = await getFileContent(owner, name, path, branch, token);
      if (file == null) continue;
      await prisma.projectFile.create({
        data: { project_id: project.id, created_by_id: user.id, path, content: file.content, language: detectLanguage(path) },
      });
      added.push(path);
    } catch { /* skip one bad file */ }
  }
  return { added: added.length, paths: added };
}

export function detectWpContext(files = []) {
  const themes = new Set();
  const plugins = new Set();
  for (const f of files) {
    let m = f.path.match(/^wp-content\/themes\/([^/]+)\//);
    if (m) themes.add(m[1]);
    m = f.path.match(/^wp-content\/(?:mu-plugins|plugins)\/([^/]+)\//);
    if (m) plugins.add(m[1]);
  }
  return { themes: [...themes], plugins: [...plugins], hasThemeFiles: themes.size > 0 };
}

export function wordpressPromptBlock({ repo, files } = {}) {
  const { themes, hasThemeFiles } = detectWpContext(files);
  const themeLine = hasThemeFiles
    ? `Theme(s) in this project (from the imported files): ${themes.join(', ')}. Prefer the child theme for overrides if one is present.`
    : `No theme files are imported yet — the operator should pull the theme folder in from the WEBSITE panel → CODE tab before you make theme changes. Say so in your plan rather than guessing.`;

  return `
WORDPRESS SITE — this project is the code of a LIVE WordPress + WooCommerce site${repo ? ` (repo: ${repo})` : ''}. Read before planning or writing code:
- The files here are a WORKING SUBSET of a full WordPress install — the theme, child theme, snippets and templates the operator chose to edit. WP core and other plugins live on the server and are NOT in this project.
- You are NOT building a standalone web app. Do NOT create index.html, package.json, a bundler/build config, a React or Vue app, or a src/ tree. There is no build step — files are written to the server exactly as you write them.
- Edit PHP templates, theme functions and theme CSS/JS the WordPress way: the template hierarchy, hooks and filters, wp_enqueue_script/style in functions.php, the child theme for overrides.
- ${themeLine}
- NEVER create, modify or delete: wp-config.php, wp-load.php, wp-settings.php, anything under wp-admin/ or wp-includes/, wp-content/uploads/, .htaccess, .user.ini, or a plugin directory the operator didn't author. The deploy step rejects these regardless — don't propose them.
- If you need a file that isn't in CURRENT FILES (e.g. header.php, functions.php, a template part), state exactly which files in your plan. The operator can import them from the CODE tab.
- Changes ship through the WEBSITE panel's Deploy tab: your file writes become a pull request, auto-merge on green, then the plugin writes them to the live server with a health check and auto-rollback. Keep changes small and reversible.
`;
}
