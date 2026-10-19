// CLEAN MY SITE: the app's half of the rules that decide what a person is told
// and what a single press is allowed to change.
//
// WHY THIS IS A SEPARATE, IMPORT-FREE MODULE (except for the equally pure
// lib/siteHealth.js)
//
// scripts/verify-clean-site.mjs asserts the rules below in CI's NO-INSTALL
// guards job, which runs without `npm install` (hazard H4). Anything reached
// from here must be loadable without a package boundary — see
// scripts/verify-guards-no-install.mjs, which fails the job if this file ever
// grows an import that is not pure. lib/siteHealth.js is pure for the same
// reason (it labels the sources and normalises the fix shape), so reusing it
// costs nothing and keeps one definition of those two things.
//
// WHAT CLEAN MY SITE IS FOR
//
// The health scan asks WordPress whether the site is well. This asks a harder
// question: *what is on this server that nobody asked for, and what is left
// behind?* A modified core file, a PHP file in uploads/, a wp-config backup
// sitting in the site root answering over HTTP, a mu-plugin nobody remembers
// installing. Those are invisible to WordPress's own Site Health screen and to
// the Plugins list, and they are the standard persistence mechanisms after a
// compromise.
//
// THE FOUR RULES THIS MODULE ENFORCES
//
//   1. NEVER DELETE — QUARANTINE. Every removal the plugin performs renames the
//      file with a timestamp, and the panel states the backup's name so the
//      operator has an undo. Nothing here ever asks for a delete.
//   2. TWO PRESSES, NOT ONE. The scan is its own signed request, with its own
//      cache — it does NOT ride along with the health scan, because it is
//      heavier (a checksum pass over core, plugins and uploads). Opening the
//      panel must not run it, and one press must not scan-and-clean.
//   3. ANYTHING RISKY IS `guided`. A modified core file, an unknown admin
//      account, a cron entry we cannot attribute: reported with the exact
//      instruction, never applied by an automated pass. Re-downloading core over
//      a live site is not a decision a button gets to make.
//   4. BOUNDED, AND HONEST ABOUT WHAT IT SKIPPED. The scan caps how much it
//      hashes and downloads and reports the cap it hit and what it never
//      reached. A clean bill of health that silently skipped half the site is
//      worse than no scan at all.
//
// The plugin remains the only thing that DECIDES and the only thing that WRITES.
// Nothing here re-implements a detection rule: two implementations would be two
// answers to one question.

import { normaliseFix, severityRank, SOURCE_LABELS, attemptRecord, attemptLine } from './siteHealth.js';

/**
 * The action the app sends to the plugin's ONE signed health route.
 *
 * The plugin's `Morpheus_REST::handle_health()` switches on this string. Rename
 * it on either side and the app's CLEAN MY SITE scan becomes WordPress's raw
 * "unknown action" (or, before that, a health scan) with nothing on screen
 * saying which — which is why scripts/verify-clean-site.mjs parses both halves
 * and compares them.
 */
export const CLEAN_ACTION = 'clean';

/** The action that runs one fix, reused from the health panel. */
export const FIX_ACTION = 'fix';

/**
 * Every finding id the clean scan can produce.
 *
 * The ids are the contract between four places: the plugin's scan (which emits
 * them), the plugin's fix registry (which must have an entry for every id, or
 * the finding is UNMAPPED), the app's safe-set rule below (a finding is only
 * ever applied if this module recognises it AND the registry calls it `auto`),
 * and the guard.
 *
 * `auto` here means "the plugin's registry says auto too" — this list is a
 * cross-check, not a second source of truth. A finding in this list that the
 * registry has as `guided` is a bug the guard catches.
 */
export const CLEAN_FINDING_IDS = [
  // ── safe to clean: rename, never delete ──────────────────────────────
  'morpheus_uploads_php',          // a .php file under uploads/ — nothing legitimate is PHP there
  'morpheus_root_config_backup',   // wp-config.php.bak / .env in the site root — a credential leak
  'morpheus_public_debug_log',     // wp-content/debug.log answering over HTTP
  'morpheus_stale_robots_txt',     // the existing finding, owned by the SEO module

  // ── report only: a person decides ────────────────────────────────────
  'morpheus_core_checksums',       // a modified core file is the classic persistence mechanism
  'morpheus_plugin_checksums',     // a modified file in a wordpress.org-hosted plugin
  'morpheus_mu_plugins',           // auto-loaded, invisible in the Plugins screen
  'morpheus_admin_users',          // who can install plugins and edit files
  'morpheus_cron_unattributed',    // a scheduled hook we cannot attribute to anything loaded
  'morpheus_recent_files',         // what changed on the site recently, newest first
];

/**
 * The findings a single press may apply.
 *
 * TWO conditions, and both are needed:
 *
 *   * the site's own registry calls it `auto` — never `guided`, `updates` or
 *     `none`. Derived from the payload rather than from a list here, so a plugin
 *     that downgrades a fix shrinks this press without any change on this side;
 *   * the finding ASKS for something (`critical` or `recommended`). A `good`
 *     finding wearing an `auto` fix — "the debug log is not readable over the
 *     web", "there is no stale robots.txt" — has nothing to clean, and a press
 *     that renamed a file in response to a check that passed would be a change
 *     nobody asked for. An `unknown` one is an unanswered question, and an
 *     unanswered question is not consent either.
 *
 * Those two auto findings still carry their FIX control individually, so the
 * operator can act on one deliberately — that is a second press with the finding
 * on screen, which is exactly what the bulk set must not do on their behalf.
 */
export const SAFE_SET_STATUSES = ['critical', 'recommended'];

export function safeSet(findings = []) {
  return (Array.isArray(findings) ? findings : [])
    .filter((f) => f && f.fix && f.fix.kind === 'auto' && SAFE_SET_STATUSES.includes(String(f.status || '').toLowerCase()));
}

/**
 * The findings a person must look at: everything with a `guided` or `updates`
 * action. They are never swept into a press, whatever their status.
 */
export function reportOnly(findings = []) {
  return (Array.isArray(findings) ? findings : [])
    .filter((f) => f && f.fix && (f.fix.kind === 'guided' || f.fix.kind === 'updates'));
}

/**
 * Map the plugin's clean payload into the same finding shape the health panel
 * renders, worst first.
 *
 * The mapper is the only path from the plugin's scan to a button, so dropping
 * `fix` here would make the whole engine invisible while it worked perfectly —
 * the failure the health scan already shipped once. The guard asserts it.
 */
export function cleanFindings(scan = {}) {
  const rows = Array.isArray(scan.findings) ? scan.findings : [];
  return rows
    .map((f, i) => ({
      id: f.id,
      label: f.label || f.id,
      status: String(f.status || 'unknown').toLowerCase(),
      badge: f.badge || '',
      description: f.description || '',
      links: Array.isArray(f.links) ? f.links : [],
      details: Array.isArray(f.details) ? f.details : [],
      fix: normaliseFix(f.fix),
      // The site's record of the LAST attempt at this finding, if there was one.
      // A refusal used to be invisible: the panel rescanned to the same count
      // with nothing saying why. It is carried on the finding — not decided here
      // — so a reload reads it back from the site, and it is rendered as a
      // RECORD, never as a claim: `attemptLine()` turns only an explicit `done`
      // into a success sentence, and the finding's own status is untouched.
      last_attempt: attemptRecord(f.last_attempt),
      attempt_line: attemptLine(f.last_attempt),
      // Every clean finding is ours: WordPress's Site Health has no opinion about
      // a PHP file in uploads/. Kept as a field anyway so a future check that
      // quotes WordPress cannot be presented as ours by accident.
      source: 'morpheus',
      sourceLabel: SOURCE_LABELS.morpheus,
      _i: i,
    }))
    .sort((a, b) => severityRank(a.status) - severityRank(b.status) || a._i - b._i)
    .map(({ _i, ...f }) => f);
}

/**
 * Counts and the one-line headline. No score, and the same reason as the health
 * panel: a number invites optimising the number.
 *
 * `cleanable` is the size of the safe set — how many things one press can act on
 * right now, which is not the same as how many automatic fixes exist: an `auto`
 * finding that already reads `good` has nothing to clean. `skipped` is how much
 * of the site the scan never reached. Both are part of the headline's meaning,
 * not a footnote, because "nothing found" and "nothing looked at" read
 * identically otherwise.
 */
export function cleanSummary(scan = {}) {
  const all = cleanFindings(scan);
  const count = (s) => all.filter((f) => f.status === s).length;
  const critical = count('critical');
  const recommended = count('recommended');
  const unknown = count('unknown');
  const good = count('good');
  const cleanable = safeSet(all).length;
  const skipped = Array.isArray(scan.skipped) ? scan.skipped.length : 0;

  let headline;
  if (!all.length) {
    headline = 'The clean scan returned no checks at all, which is not the same as a clean site — the plugin could not run its own checks.';
  } else if (critical) {
    headline = `${critical} thing${critical === 1 ? '' : 's'} on this site need${critical === 1 ? 's' : ''} looking at now${cleanable ? `, and ${cleanable} of them can be quarantined here` : ''}.`;
  } else if (recommended) {
    headline = `Nothing critical. ${recommended} thing${recommended === 1 ? '' : 's'} worth reviewing${cleanable ? `, and ${cleanable} can be quarantined here` : ''}.`;
  } else if (cleanable) {
    headline = `${cleanable} thing${cleanable === 1 ? '' : 's'} can be quarantined here. Nothing else was found.`;
  } else {
    headline = 'Nothing was found to clean, and nothing needs reviewing.';
  }
  if (skipped) {
    headline += ` ${skipped} check${skipped === 1 ? '' : 's'} could not finish — see what was skipped below.`;
  }

  return { total: all.length, critical, recommended, unknown, good, cleanable, skipped, headline };
}

/**
 * What the scan did NOT reach, in the operator's words.
 *
 * A capped pass reports the cap it hit and how far it got, and never turns into
 * a number on its own. This is the difference between "we looked everywhere and
 * found nothing" and "we looked at the first 2,500 files" — and only one of them
 * is a clean bill of health.
 */
export function cleanLimits(scan = {}) {
  const skipped = Array.isArray(scan.skipped) ? scan.skipped : [];
  const limits = scan.limits && typeof scan.limits === 'object' ? scan.limits : null;
  const measured = [];
  if (limits) {
    if (Number.isFinite(Number(limits.seconds))) {
      measured.push(`The scan took ${Number(limits.seconds).toFixed(1)}s on the site.`);
    }
    if (Number(limits.hash_files_cap)) {
      measured.push(`It checksummed ${Number(limits.hash_files) || 0} of a maximum ${Number(limits.hash_files_cap)} core files.`);
    }
    if (Number(limits.uploads_cap)) {
      measured.push(`It looked at ${Number(limits.uploads_scanned) || 0} uploads files (cap ${Number(limits.uploads_cap)}).`);
    }
    if (Number(limits.package_plugins_cap)) {
      measured.push(`It verified ${Number(limits.package_plugins) || 0} plugin package${Number(limits.package_plugins) === 1 ? '' : 's'} (cap ${Number(limits.package_plugins_cap)}, ${formatBytes(limits.package_bytes)} of ${formatBytes(limits.package_bytes_cap)} downloaded).`);
    }
  }
  return {
    hasLimits: !!(limits || skipped.length),
    measured,
    skipped: skipped.map((s) => ({
      check: s.check || '',
      reason: s.reason || 'the site did not say why this check did not finish',
      reached: s.reached === undefined ? null : s.reached,
      of: s.of === undefined ? null : s.of,
    })),
    // The one sentence that must never be missing when something was skipped.
    caveat: skipped.length
      ? 'This is not a clean bill of health: the checks listed here did not finish, and each says how far it got.'
      : null,
  };
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} bytes`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The undo, read out of a clean fix result.
 *
 * Returns null unless the site actually reported quarantined files, so
 * "cleaned" can never be shown without the operator being told where the file
 * went. Nothing is invented: every field comes from the site's own answer.
 */
export function cleanQuarantineEvidence(fix, findingId) {
  if (!fix || typeof fix !== 'object') return null;
  if (!CLEAN_FINDING_IDS.includes(findingId)) return null;
  const rows = Array.isArray(fix.quarantined) ? fix.quarantined : [];
  const moved = rows.filter((r) => r && typeof r.backup === 'string' && r.backup);
  if (!moved.length) return null;
  return {
    id: findingId,
    count: moved.length,
    files: moved.map((r) => ({
      file: String(r.file || ''),
      backup: String(r.backup || ''),
      // A file the site put back is NOT quarantined, and saying otherwise would
      // tell the operator their site changed when it did not.
      verified: r.verified === true,
      restored: r.restored === true,
    })),
    allVerified: moved.every((r) => r.verified === true && r.restored !== true),
    restored: moved.some((r) => r.restored === true),
  };
}

/** The line under a clean result naming every undo, in the site's own terms. */
export function cleanUndoLine(evidence) {
  if (!evidence || !evidence.files?.length) return null;
  const parts = evidence.files.map((f) => (f.restored
    ? `${f.backup || f.file} was put back, so nothing is quarantined`
    : `${f.file} → ${f.backup}`));
  const head = evidence.restored
    ? 'Nothing is quarantined.'
    : `${evidence.count} file${evidence.count === 1 ? '' : 's'} renamed, nothing deleted.`;
  return `${head} ${parts.join('; ')}. To undo, rename the backup back to its original name.`;
}
