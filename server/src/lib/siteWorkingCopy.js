// Naming a working copy, and saying what is in it.
//
// Kept pure (no imports) so the guards job can test it without an install, and
// so the naming rule lives in one place: a repo name is the operator's first
// impression of this feature, and "morpheus-build-1789856508" tells them
// nothing while "valiantmusic-com-au-theme" tells them everything.

/**
 * A repo name for a site's working copy.
 *
 * Host first (that is the part people recognise), then the path when the site
 * lives in a subdirectory, because two sites on one host must not collide.
 * Anything GitHub would reject is stripped rather than escaped, and the result
 * is capped well under GitHub's 100-character limit so a suffix can still be
 * added by hand.
 */
export function repoNameForSite(siteUrl, fallbackName = '') {
  let host = '';
  let path = '';
  try {
    const u = new URL(/^https?:\/\//i.test(String(siteUrl)) ? String(siteUrl) : `https://${siteUrl}`);
    host = u.hostname.replace(/^www\./i, '');
    path = u.pathname.replace(/^\/+|\/+$/g, '');
  } catch {
    // Nonsense still has to name something recognisable, so the scheme is
    // stripped here too — otherwise "https://My Shop!.example.com/a b" (which
    // does not parse as a URL) came out as "https-my-shop-.example.com-...".
    host = String(siteUrl || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  }
  const base = [host, path].filter(Boolean).join('-') || String(fallbackName || 'site');
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')   // everything GitHub disallows, including dots in hosts
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80)
    .replace(/[-._]+$/, '');
  return `${cleaned || 'site'}-theme`;
}

/**
 * A one-line summary of what was and was not copied, for the UI and the tests.
 * `skipped_count` is deliberately surfaced rather than hidden: a working copy
 * without its images is fine, but the operator has to be told.
 */
export function describeWorkingCopy({ files = 0, bytes = 0, skippedCount = 0, reused = false, themeName = '' } = {}) {
  const size = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const parts = [`${files} file${files === 1 ? '' : 's'} (${size})`];
  if (themeName) parts.push(themeName);
  if (skippedCount) parts.push(`${skippedCount} binary/large file${skippedCount === 1 ? '' : 's'} left on the site`);
  if (reused) parts.push('added to the repo you already had with that name');
  return parts.join(' · ');
}
