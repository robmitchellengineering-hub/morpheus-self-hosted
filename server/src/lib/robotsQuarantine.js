// The app's half of the robots.txt quarantine contract.
//
// WHY THIS IS A SEPARATE, IMPORT-FREE MODULE
//
// scripts/verify-seo.mjs asserts the rules here in CI's NO-INSTALL guards job.
// That job runs without `npm install` (hazard H4), so anything it reaches must
// be loadable without a package boundary — see
// scripts/verify-guards-no-install.mjs, which fails the job if this file ever
// grows an import. Pure and dependency-free for exactly that reason.
//
// WHAT IT IS FOR
//
// Quarantining a stale physical robots.txt is a WRITE to the site's document
// root that only the plugin can perform. Two things live on this side of the
// boundary, and both fail silently if they ever drift from the plugin's PHP:
//
//   * the FINDING ID. The app echoes back whatever id the scan produced, so a
//     rename on the plugin side does not break the request — it quietly stops
//     this module recognising the fix, and the operator loses the undo path
//     from the panel while everything still reports success.
//   * the BACKUP NAME. The undo is a renamed file: `robots.txt` becomes
//     `robots.txt.morpheus-bak-YYYYMMDDHHMMSS` beside it. That name is the only
//     way back for an owner who cannot reach cPanel, so the panel states where
//     it is rather than expecting the operator to find a filename inside a
//     sentence.
//
// The plugin remains the only thing that DECIDES and the only thing that WRITES
// (see wp-plugin/morpheus/includes/seo/class-seo.php's robots_txt_state() and
// class-fixes.php's fix_quarantine_robots_txt()). Nothing here re-implements
// the staleness rule: two implementations would be two answers to one question,
// and the last time this repo did that the answers disagreed.

/**
 * The finding id the plugin registers in Morpheus_Fixes::registry() and the
 * app sends back to /fix. Asserted against the plugin's PHP by verify-seo.mjs —
 * a mismatch is a silent no-op, not an error.
 */
export const ROBOTS_FINDING_ID = 'morpheus_stale_robots_txt';

/**
 * What a quarantined robots.txt is renamed behind. The timestamp is UTC
 * (`gmdate` on the plugin side) so the name does not depend on the site's
 * timezone setting, and so two sites read the same way in a report.
 */
export const ROBOTS_BACKUP_PREFIX = 'robots.txt.morpheus-bak-';

/** The exact shape of a quarantine backup name, anchored. */
const BACKUP_RE = /^robots\.txt\.morpheus-bak-\d{14}$/;

/**
 * The backup name for a moment in time — `robots.txt.morpheus-bak-20260923160200`.
 *
 * Exported so the naming rule is asserted rather than described: the plugin
 * builds the real one with `gmdate( 'YmdHis' )`, and a format change on either
 * side is caught here.
 *
 * @param {Date} [at] defaults to now
 */
export function backupName(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${ROBOTS_BACKUP_PREFIX}${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Is this a quarantine backup name — i.e. a file this feature made? */
export function isBackupName(name) {
  return typeof name === 'string' && BACKUP_RE.test(name);
}

/** The backup's basename, from a path or a name. '' when there is none. */
export function backupBasename(path) {
  if (typeof path !== 'string' || !path) return '';
  const base = path.split(/[\\/]/).pop() || '';
  return isBackupName(base) ? base : '';
}

/**
 * The undo, read out of the site's own fix result.
 *
 * Returns null unless the finding IS the quarantine (so a rename on the plugin
 * side is caught) AND the site actually reported a backup (so "success" can
 * never be shown without the file being recoverable — which is the whole
 * promise of quarantine-instead-of-delete).
 *
 * Nothing is invented here. `backup` is the site's path, `restored` is the
 * site's own flag, and `quarantined` is true only when the site said the file
 * was moved (`did` present) — the panel shows the site's words, not this
 * module's.
 *
 * @param {object|null} fix the plugin's fix payload
 * @param {string} findingId the finding that was sent
 */
export function quarantineEvidence(fix, findingId) {
  if (findingId !== ROBOTS_FINDING_ID) return null;
  if (!fix || typeof fix !== 'object') return null;
  const backup = typeof fix.backup === 'string' ? fix.backup : '';
  const name = backupBasename(backup);
  if (!name) return null;
  return {
    backup,
    name,
    // A rollback means the file is back where it was: nothing is quarantined,
    // and saying otherwise would tell the operator their site changed when it
    // did not.
    quarantined: fix.restored !== true && fix.verified === true,
    restored: fix.restored === true,
    verified: fix.verified === true,
  };
}

/**
 * The line under a quarantine result naming the undo, in the site's own terms.
 *
 * Deliberately says the whole filename: an operator on a phone with no cPanel
 * needs something they can read out to whoever does hold the hosting account.
 */
export function undoLine(evidence) {
  if (!evidence || !evidence.name) return null;
  if (evidence.restored) {
    return `The old file was put back as ${evidence.name}, so nothing is quarantined — the site is exactly as it was.`;
  }
  if (!evidence.quarantined) return null;
  return `To undo this, rename ${evidence.name} back to robots.txt in the site's root folder. Nothing was deleted.`;
}
