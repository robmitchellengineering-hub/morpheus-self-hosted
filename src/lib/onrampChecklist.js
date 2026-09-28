// Which rows the first-run checklist shows, and what counts towards "N to go".
//
// Pure and import-free on purpose: `scripts/verify-onramp.mjs` runs in CI's
// no-install job, and the same reason `lib/deckMemoryText.js` exists — a guard
// that imports the component drags in React, Radix and the API client with it.
//
// WHY THE DECISION IS SEPARATE FROM THE ROWS. Two paths now open a web-app
// construct (/start for a WordPress site you already run, /begin for a site
// Morpheus builds), and the checklist used to show the WordPress steps to both.
// The rule for which path you are on is worth testing on its own, without a
// browser: it is one boolean read from the system, and getting it wrong is
// exactly the bug this fixes.

/** The WordPress rows, which only make sense once a site is actually connected. */
export const WORDPRESS_ROWS = ['site', 'copy'];

/**
 * The rows to render, in order, for the state the construct is in.
 *
 * `loadingSite` suppresses the path-specific rows entirely: while the WordPress
 * check is in flight we do not yet know which path this is, and guessing shows a
 * WordPress operator the build rows for a moment — the same confusion, just
 * faster.
 */
export function checklistRows({ loadingSite, siteConnected }) {
  const keys = ['github'];
  if (!loadingSite) {
    keys.push(...(siteConnected ? WORDPRESS_ROWS : ['hosting', 'wordpress']));
  }
  keys.push('change');
  return keys;
}

/**
 * A row nobody has to do to be set up. The WordPress row is offered on the build
 * path so the other way stays findable, but it must not count — otherwise "done"
 * would mean "you dealt with something you were never asked to do", and the
 * checklist would refuse to retire until a website builder connected WordPress.
 */
export function isOptionalRow(key) {
  return key === 'wordpress';
}

/**
 * How many rows are left, counting only the ones that were actually asked for.
 * `done` is a map of row key → boolean.
 */
export function remainingCount(keys, done) {
  return keys.filter((k) => !isOptionalRow(k) && !done[k]).length;
}
