// Site maintenance policy — what Morpheus may do to a site unprompted, and when.
//
// Pure and dependency-free so the rules are asserted directly by
// scripts/verify-site-maintenance.mjs in CI's no-install guards job.
//
// THE RULE THIS FILE EXISTS TO KEEP
//
// Scanning and applying are separate permissions. An owner who asked to be TOLD
// what is wrong has not asked us to change their site, and the two must never be
// inferable from each other — so `scan_enabled` grants nothing but a scan, and
// every `apply_*` flag stands on its own with a default of false.
//
// And one thing is not configurable at all: a MAJOR core update is never
// automatic. It is the one operation here that can take a working site away and
// leave no obvious way back (a major core change can break plugins, themes and
// custom code at once, and the site's own rollback only covers a failure during
// the update, not "it worked and now the shop is broken"). Offering a checkbox
// for it would be putting a loaded gun in a settings screen, so the policy has
// no such field, `mayApply` refuses it by construction, and the check asserts
// that refusal survives.

/** Every field, at its safest value. A policy is always this plus what the owner turned on. */
export const POLICY_DEFAULTS = Object.freeze({
  scan_enabled: false,
  // 1-28, so a monthly run exists in every month including February.
  day_of_month: 1,
  hour_utc: 3,
  apply_plugins: false,
  apply_themes: false,
  apply_core_minor: false,
  // Records that a human may be OFFERED a major core update. It never means
  // "apply it", and no code path reads it as permission.
  allow_core_major_manual: true,
});

export const MAX_DAY_OF_MONTH = 28;

const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

function intInRange(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return i >= min && i <= max ? i : fallback;
}

/**
 * Validate what a caller asked for, field by field, keeping everything it did
 * not mention.
 *
 * Out-of-range values are REPORTED rather than silently clamped: an operator who
 * asked for the 31st should be told the day is capped at 28, not quietly given
 * the 28th and left believing the 31st.
 */
export function validatePolicy(input = {}, current = POLICY_DEFAULTS) {
  const errors = [];
  const base = { ...POLICY_DEFAULTS, ...current };
  const next = { ...base };

  for (const key of ['scan_enabled', 'apply_plugins', 'apply_themes', 'apply_core_minor', 'allow_core_major_manual']) {
    if (key in input) next[key] = bool(input[key], base[key]);
  }

  if ('day_of_month' in input) {
    const n = Number(input.day_of_month);
    const i = Number.isFinite(n) ? Math.trunc(n) : NaN;
    if (!(i >= 1 && i <= MAX_DAY_OF_MONTH)) {
      errors.push(`day_of_month must be between 1 and ${MAX_DAY_OF_MONTH} (a day every month has, so a monthly run cannot skip February)`);
    } else {
      next.day_of_month = i;
    }
  }

  if ('hour_utc' in input) {
    const n = Number(input.hour_utc);
    const i = Number.isFinite(n) ? Math.trunc(n) : NaN;
    if (!(i >= 0 && i <= 23)) errors.push('hour_utc must be between 0 and 23');
    else next.hour_utc = i;
  }

  return { ok: errors.length === 0, policy: errors.length ? base : next, errors };
}

/**
 * The scheduled instant in the current month, the one before it, or the one
 * after — in UTC, because hour_utc has to mean the same thing wherever the
 * server happens to run.
 *
 * `next: false` means "the most recent instant that has ALREADY passed", which
 * is the month BEFORE when this month's day has not arrived yet. Getting that
 * wrong is not cosmetic: `isDue()` compares against this, so returning next
 * month's date here meant a run missed while the server was down was never made
 * up — the one behaviour the schedule exists to guarantee. (The check caught it.)
 */
export function scheduledInstant(policy, now, { next = false } = {}) {
  const p = { ...POLICY_DEFAULTS, ...policy };
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const thisMonth = Date.UTC(y, m, p.day_of_month, p.hour_utc, 0, 0);
  // Date.UTC normalises month -1 and 12 into the adjacent year.
  if (next) {
    return thisMonth > now ? thisMonth : Date.UTC(y, m + 1, p.day_of_month, p.hour_utc, 0, 0);
  }
  return thisMonth <= now ? thisMonth : Date.UTC(y, m - 1, p.day_of_month, p.hour_utc, 0, 0);
}

export function nextRunAt(policy, now = Date.now()) {
  const p = { ...POLICY_DEFAULTS, ...policy };
  return p.scan_enabled ? scheduledInstant(p, now, { next: true }) : null;
}

/**
 * Is this policy's monthly scan due?
 *
 * Due means: the scan is on, the most recent scheduled instant has passed, and
 * the last scan was before it. Comparing against the SCHEDULED instant rather
 * than "30 days ago" is what makes a missed month run once when the server comes
 * back, instead of either skipping it or running it repeatedly.
 */
export function isDue(policy, now = Date.now()) {
  const p = { ...POLICY_DEFAULTS, ...policy };
  if (!p.scan_enabled) return false;
  const due = scheduledInstant(p, now, { next: false });
  if (due > now) return false;
  const last = p.last_scan_at ? new Date(p.last_scan_at).getTime() : 0;
  return !(last && last >= due);
}

/**
 * May this policy apply a given kind of update with nobody watching?
 *
 * `core_major` is refused unconditionally — see the note at the top. The refusal
 * is returned as data rather than thrown, so a caller can explain it instead of
 * dying on it.
 */
export function mayApply(policy, kind, { manual = false } = {}) {
  const p = { ...POLICY_DEFAULTS, ...policy };
  if (kind === 'core_major') {
    return {
      allowed: false,
      reason: manual
        ? 'A major WordPress update is never applied automatically. It is offered to the owner to approve, because it can break plugins and themes at once.'
        : 'A major WordPress update is never applied automatically, and this is not an owner-approved run.',
    };
  }
  const flag = { plugin: 'apply_plugins', theme: 'apply_themes', core_minor: 'apply_core_minor' }[kind];
  if (!flag) return { allowed: false, reason: `Unknown update kind: ${kind}` };
  if (!p[flag]) {
    return {
      allowed: false,
      reason: kind === 'core_minor'
        ? 'Minor and security WordPress updates are not enabled for unattended runs on this site.'
        : `Unattended ${kind} updates are not enabled for this site.`,
    };
  }
  return { allowed: true, reason: null };
}

/** Which kinds an unattended run would be allowed to apply, and which it would merely report. */
export function allowedKinds(policy) {
  const applicable = [];
  const reported = [];
  for (const kind of ['plugin', 'theme', 'core_minor', 'core_major']) {
    if (mayApply(policy, kind).allowed) applicable.push(kind);
    else reported.push(kind);
  }
  return { applicable, reported };
}

const ORDINAL = (d) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;

/** A sentence an operator can check against what they thought they chose. */
export function describePolicy(policy) {
  const p = { ...POLICY_DEFAULTS, ...policy };
  if (!p.scan_enabled) {
    return 'No scheduled checks. Morpheus will only look at this site when you ask it to.';
  }
  const { applicable } = allowedKinds(p);
  const when = `Monthly on the ${ORDINAL(p.day_of_month)} at ${String(p.hour_utc).padStart(2, '0')}:00 UTC`;
  if (!applicable.length) {
    return `${when}: Morpheus checks the site and reports what it finds. It will not change anything — applying updates is switched off for this site.`;
  }
  const names = { plugin: 'plugin', theme: 'theme', core_minor: 'minor WordPress' };
  const list = applicable.map((k) => names[k] || k);
  const tails = applicable.includes('core_major') ? '' : ' Major WordPress updates are reported, never applied.';
  return `${when}: Morpheus checks the site, reports what it finds, and applies ${list.join(', ')} updates.${tails}`;
}

/**
 * The message a scheduled run leaves behind.
 *
 * Written for someone reading it on a phone a month later, so it leads with what
 * needs them, and it never claims more than the run actually did.
 */
export function runSummary({ scan = {}, policy = {}, applied = [], failed = [], skipped = [], at = Date.now() } = {}) {
  const critical = Number(scan?.summary?.critical || 0);
  const recommended = Number(scan?.summary?.recommended || 0);
  const updates = Number(scan?.update_plan?.total || 0);

  const lines = [];
  lines.push(`Scheduled site check for ${scan?.site?.name || 'your site'} (${scan?.site?.url || 'unknown URL'}).`);
  if (critical) lines.push(`${critical} thing${critical === 1 ? '' : 's'} need${critical === 1 ? 's' : ''} fixing now, ${recommended} more worth doing.`);
  else if (recommended) lines.push(`Nothing critical. ${recommended} recommendation${recommended === 1 ? '' : 's'}.`);
  else lines.push('Every check passed.');
  lines.push(`${updates} update${updates === 1 ? '' : 's'} available.`);

  if (applied.length) lines.push(`Applied: ${applied.join(', ')}.`);
  if (failed.length) lines.push(`FAILED and left alone: ${failed.join(', ')}.`);
  if (skipped.length) lines.push(`Reported but not applied: ${skipped.join(', ')}.`);

  const p = { ...POLICY_DEFAULTS, ...policy };
  if (!p.apply_plugins && !p.apply_themes && !p.apply_core_minor) {
    lines.push('Applying updates is switched off for this site, so nothing was changed.');
  }
  if (scan?.can_apply && scan.can_apply.ok === false) {
    lines.push(`This site cannot have its files written: ${(scan.can_apply.reasons || []).join('; ')}`);
  }
  return lines.join('\n');
}
