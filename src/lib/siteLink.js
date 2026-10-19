// A link that came from a customer's WordPress plugin, made safe to render in
// the Morpheus app.
//
// WHY THIS EXISTS EVEN THOUGH THE PLUGIN NOW SENDS ABSOLUTE URLS
//
// Every guided step link in `wp-plugin/morpheus/includes/class-fixes.php` is now
// built with `admin_url( 'users.php' )` and friends, which respects a site whose
// wp-admin lives somewhere other than `/wp-admin/`. But the plugin and this app
// ship SEPARATELY: the app is deployed from this repo while each customer's
// plugin updates on its own schedule, so an app release routinely renders a
// payload from a plugin that predates the fix — and a new finding whose author
// writes a path out of habit is one code review away.
//
// The failure that shape produces is not a broken link, it is a broken PRODUCT.
// A root-relative `/wp-admin/users.php` in an href resolves against the ORIGIN
// THE PANEL IS LOADED FROM — morpheus.nz — so it hits this app's own catch-all
// route and renders Morpheus's "Page Not Found / the AI hasn't implemented this
// page yet" screen. The operator clicking a link to their own site is told the
// site does not exist. A value that 404s inside the app is indistinguishable
// from a broken product, so the panel resolves it against the connected site's
// own base URL instead of leaving it to the browser.
//
// It is deliberately dependency-free: `scripts/verify-clean-site.mjs` imports it
// directly to test its behaviour (not a regex over its source), and that guard
// runs in CI's no-install job, which cannot import anything that reaches a
// package. See scripts/verify-guards-no-install.mjs.
//
// Run:  node scripts/verify-clean-site.mjs

/**
 * Resolve a plugin-supplied link against the connected site's own base URL.
 *
 *   resolveSiteLink( '/wp-admin/users.php', 'https://shop.example' )
 *     → 'https://shop.example/wp-admin/users.php'
 *   resolveSiteLink( 'https://shop.example/wp-admin/x', 'https://shop.example' )
 *     → unchanged (already absolute)
 *   resolveSiteLink( '/wp-admin/x', '' )
 *     → '/wp-admin/x' (no site to resolve against; nothing to invent)
 *
 * A protocol-relative `//host/path` is treated as root-relative too, so a value
 * the site sends can never navigate the operator off to a third-party origin.
 *
 * @param {unknown} link   the value the plugin sent
 * @param {unknown} siteUrl the connected site's URL (`site.url` in the scan)
 * @returns {unknown} the value to put in the href
 */
export function resolveSiteLink(link, siteUrl) {
  if (typeof link !== 'string' || link === '') return link;
  // Anything not beginning with `/` is already absolute (http(s):, mailto:, …)
  // and is rendered exactly as the site sent it.
  if (!link.startsWith('/')) return link;
  const base = typeof siteUrl === 'string' ? siteUrl.replace(/\/+$/, '') : '';
  if (!base) return link;
  return `${base}${link}`;
}
