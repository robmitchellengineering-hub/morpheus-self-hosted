// Applying the updates a policy allows — the I/O around a pure decision.
//
// The decision itself (`kindsToApply`) is in lib/siteMaintenance.js and is
// asserted there. This file does three things and nothing else: turn the allowed
// kinds into the plugin's target list, ask the SITE what it will do (it re-checks
// its own update offer, because ours may be minutes old), and translate the
// per-target results into what a report and a caller can use.
//
// The site is the authority on what is updatable. We send (kind, id) pairs — never
// versions or URLs — so a stale scan cannot make Morpheus install something the
// site no longer offers.
import { wpMaintenance } from './wpPlugin.js';
import { kindsToApply } from './siteMaintenance.js';
import { isPluginTooOld } from './siteHealth.js';

/** The plugin's target list for the kinds a policy allows. */
export function targetsFor(scan = {}, kinds = []) {
  const plan = scan.update_plan || {};
  const targets = [];
  for (const kind of kinds) {
    if (kind === 'plugin') {
      for (const p of plan.plugins || []) targets.push({ kind: 'plugin', id: p.file, name: p.name });
    } else if (kind === 'theme') {
      for (const t of plan.themes || []) targets.push({ kind: 'theme', id: t.stylesheet, name: t.name });
    } else if (kind === 'core_minor') {
      for (const c of plan.core || []) targets.push({ kind: 'core_minor', id: 'core', name: 'WordPress' });
    }
    // Anything else is deliberately unreachable: the list above is the only way
    // a target is built, so a kind nobody wrote here cannot be sent.
  }
  return targets;
}

const label = (r) => `${r.name || r.id}${r.from || r.to ? ` ${r.from || '?'}→${r.to || '?'}` : ''}`;

/**
 * Apply what the policy allows. `dryRun` asks the site to report without writing.
 *
 * Returns everything a report needs, including the kinds that were NOT applied
 * and why — a silent omission would read as "nothing to do".
 */
export async function applyAllowedUpdates({ conn, policy, scan, dryRun = false }) {
  const { apply, skipped } = kindsToApply(policy, scan);
  const skippedLabels = skipped.map((s) => `${s.count} ${s.kind} update${s.count === 1 ? '' : 's'} (${s.reason})`);

  if (!apply.length) {
    return {
      ok: true,
      attempted: false,
      dryRun,
      applied: [],
      failed: [],
      restored: [],
      restoreFailed: [],
      skipped: skippedLabels,
      results: [],
      message: scan?.update_plan?.total
        ? 'Updates are available but this site\'s policy does not allow Morpheus to apply any of them.'
        : 'Nothing to update.',
    };
  }

  const targets = targetsFor(scan, apply);
  // The site answers with what it actually refuses (no zip extension, unwritable
  // backup directory, an escaped path) — those are refusals, not failures, and
  // they come back per target with a reason.
  const res = await wpMaintenance(conn, { action: dryRun ? 'plan' : 'apply', targets, dryRun });

  // A site whose plugin predates the maintenance endpoint answers 404
  // rest_no_route. That is not "the site refused the update" — it is "this site's
  // plugin needs updating first", and saying so is the difference between an
  // operator acting and an operator staring at a dead button.
  const old = isPluginTooOld(res, null);
  if (old.tooOld) {
    return {
      ok: false, attempted: true, dryRun,
      applied: [], failed: [], restored: [], restoreFailed: [], skipped: skippedLabels, results: [],
      error: old.message, code: 'PLUGIN_TOO_OLD', message: old.message,
    };
  }

  const results = Array.isArray(res?.data?.results) ? res.data.results : [];

  return {
    ok: res?.data?.ok !== false,
    attempted: true,
    dryRun,
    applied: results.filter((r) => r.updated && r.verified).map(label),
    failed: results.filter((r) => (r.updated && !r.verified) || (!r.updated && r.error)).map((r) => `${label(r)}${r.error ? ` (${r.error})` : ''}`),
    restored: results.filter((r) => r.restored).map(label),
    restoreFailed: results.filter((r) => r.needs_attention).map(label),
    skipped: skippedLabels,
    results,
    // The site's own top-level refusal, if it refused before doing anything.
    error: res?.data?.ok === false ? (res.data.error || 'The site refused the update') : null,
    code: res?.data?.code || null,
    message: res?.data?.ok === false ? (res.data.error || 'The site refused the update') : null,
  };
}
