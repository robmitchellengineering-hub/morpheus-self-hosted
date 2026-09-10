// The context block handed to the planner + coder when a project is
// connected to a live WordPress site (has a PluginConnection). It tells them
// they're editing a WordPress theme inside a real install — not building a
// standalone app — and spells out what must never be touched. Paired with
// the WEBSITE panel's CODE tab (which pulls the theme files in) and the
// `wordpress` delivery adapter (which ships them).

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
