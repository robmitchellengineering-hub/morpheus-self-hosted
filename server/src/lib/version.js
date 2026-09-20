// Comparing plugin version strings, in one place.
//
// WHY THIS IS ITS OWN MODULE: it is needed by the connect wizard AND by the
// guard that verifies the wizard's thresholds, and the guard runs in CI's
// no-install job. Importing it from probeWordPress.js would drag in the plugin
// client → the database → @prisma/client, which is precisely the kind of
// transitive package import that killed that job once already (see
// scripts/verify-guards-no-install.mjs). So the comparison lives here with no
// imports at all, and both callers use it.

/**
 * Is `a` a newer version than `b`?
 *
 * Numeric part by part: a plain string compare says "0.4.10" < "0.4.9", which
 * is wrong, and a plugin that ships ten patch releases would start reporting
 * every site as up to date.
 */
export function isNewer(a, b) {
  if (!a || !b) return false;
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db;
  }
  return false;
}
