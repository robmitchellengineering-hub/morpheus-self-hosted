// Rewrites a frontend config file to point at the deployed backend URL.
// Scans for a known config file; creates src/api.js if none exists.

const CANDIDATES = ['src/api.js', 'src/config.js', 'src/lib/api.js', 'api.js', 'config.js', '.env'];

export function wireFrontend(files, apiUrl) {
  let target = files.find((f) => CANDIDATES.includes(f.path));
  let created = false;
  if (!target) {
    target = { path: 'src/api.js', content: '' };
    files.push(target);
    created = true;
  }

  const before = target.content;
  const exportLine = `export const API_BASE_URL = '${apiUrl}';`;
  let after;
  if (/API_BASE_URL\s*=/.test(before)) {
    after = before.replace(/(export\s+)?(?:const|let|var)\s+API_BASE_URL\s*=\s*['"][^'"]*['"]/, exportLine);
  } else if (before.trim()) {
    after = before.trimEnd() + '\n' + exportLine + '\n';
  } else {
    after = exportLine + '\n';
  }

  const changed = before !== after;
  target.content = after;
  const changes = changed ? [{ path: target.path, replacements: created ? 0 : 1, created }] : [];
  return {
    message: changed ? `Frontend wired to ${apiUrl}` : 'Frontend already pointed at backend.',
    apiUrl,
    configPath: target.path,
    filesChanged: changes.length,
    changes,
  };
}