// The monthly site check: scan, then apply what the owner allowed.
//
// What it may apply is decided by `kindsToApply(policy, scan)` — the intersection
// of the owner's permission and what the site actually has — and the site itself
// refuses to update anything it cannot first snapshot. Three things are therefore
// true by construction rather than by care:
//
//   * a scan-only policy (the default) applies nothing;
//   * a major core update is never applied, because `mayApply` refuses it and so
//     it can never reach `kindsToApply`'s output;
//   * an update that fails verification is put back from its pre-update backup,
//     and a restore that itself fails is reported as needing attention NOW.
//
// WHY AN HOURLY TICK FOR A MONTHLY JOB
//
// "Run on the 1st at 03:00" is not an interval, and a fixed 30-day timer drifts
// into the wrong day and skips February. Ticking hourly and asking the pure
// `isDue()` which policies are owed a run means: a run that was missed because
// the server was down happens once when it returns (not skipped, not repeated),
// and the schedule stays a wall-clock day of the month.
import { queueEnabled } from './queue.js';
import { prisma } from './db.js';
import { enabledPolicies, recordRun } from './lib/siteMaintenanceStore.js';
import { isDue, runSummary } from './lib/siteMaintenance.js';
import { scanSite } from './lib/siteScan.js';
import { applyAllowedUpdates } from './lib/siteApply.js';
import { getWpConnection } from './lib/wpPlugin.js';

const TICK_MS = 60 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 90 * 1000; // let the server finish booting first

/**
 * Run every policy that is owed a scan right now.
 *
 * Exported so it can be driven directly (tests, a manual trigger) without the
 * schedule. Returns what it did, per project — the honest record, including the
 * ones that failed.
 */
export async function runDueSiteMaintenance(now = Date.now(), { log = console } = {}) {
  const policies = await enabledPolicies();
  const outcomes = [];

  for (const policy of policies) {
    if (!isDue(policy, now)) continue;

    const project = await prisma.project.findFirst({
      where: { id: policy.project_id, created_by_id: policy.created_by_id },
      select: { id: true, name: true },
    });
    if (!project) {
      outcomes.push({ projectId: policy.project_id, status: 'no-project' });
      continue;
    }

    let scan = null;
    let outcome = null;
    let error = null;
    try {
      scan = await scanSite({ id: policy.created_by_id }, policy.project_id, { force: true });
      // Apply only what the policy allows AND the site has. `kindsToApply`
      // returns an empty list for a scan-only policy, and `applyAllowedUpdates`
      // then does not call the site at all.
      const conn = await getWpConnection(policy.project_id, policy.created_by_id);
      if (conn) {
        outcome = await applyAllowedUpdates({ conn, policy, scan });
      } else {
        error = 'the site is no longer connected';
      }
    } catch (err) {
      error = err.message;
    }

    // The report goes to the construct's chat, where the owner already is —
    // an unattended run that reports nowhere is not a report.
    const content = error
      ? `Scheduled site check for ${project.name} could not run: ${error}`
      : runSummary({
        scan,
        policy,
        applied: outcome?.applied || [],
        failed: outcome?.failed || [],
        restored: outcome?.restored || [],
        restoreFailed: outcome?.restoreFailed || [],
        skipped: outcome?.skipped || [],
      });
    try {
      await prisma.chatMessage.create({
        data: { created_by_id: policy.created_by_id, project_id: project.id, role: 'morpheus', content },
      });
    } catch (err) {
      log.warn?.('[site-maintenance] could not post the report:', err.message);
    }

    await recordRun(policy.project_id, {
      at: now,
      result: error
        ? { status: 'error', error }
        : {
          status: 'scanned',
          critical: scan.summary.critical,
          recommended: scan.summary.recommended,
          updates: scan.update_plan.total,
          canApply: scan.can_apply.ok,
          // Spelled out so a later reader can tell a scan-only run from an apply
          // run, and can see a restore, without reading the code.
          applied: outcome?.applied || [],
          failed: outcome?.failed || [],
          restored: outcome?.restored || [],
          restoreFailed: outcome?.restoreFailed || [],
          skipped: outcome?.skipped || [],
        },
    });

    outcomes.push({
      projectId: policy.project_id,
      status: error ? 'error' : 'scanned',
      error,
      applied: outcome?.applied || [],
      failed: outcome?.failed || [],
      restored: outcome?.restored || [],
    });
    log.log?.(`[site-maintenance] ${project.name}: ${error
      ? `failed — ${error}`
      : `scanned: ${scan.summary.headline}${outcome?.applied?.length ? ` Applied ${outcome.applied.length}.` : ''}${outcome?.restored?.length ? ` Restored ${outcome.restored.length}.` : ''}`}`);
  }

  return outcomes;
}

export function startSiteMaintenanceSchedule() {
  if (queueEnabled()) {
    console.log('[site-maintenance] REDIS_URL is set — scheduled via the worker process (see worker.js) instead of here.');
    return;
  }
  if (process.env.SITE_MAINTENANCE_ENABLED === 'false') {
    console.log('[site-maintenance] disabled via SITE_MAINTENANCE_ENABLED=false.');
    return;
  }

  const tick = () => {
    runDueSiteMaintenance()
      .then((outcomes) => {
        const ran = outcomes.filter((o) => o.status !== 'no-project');
        if (ran.length) console.log(`[site-maintenance] ${ran.length} site(s) due this hour.`);
      })
      .catch((err) => console.warn('[site-maintenance] tick failed:', err.message));
  };

  setTimeout(tick, FIRST_TICK_DELAY_MS);
  const timer = setInterval(tick, TICK_MS);
  // Do not hold the process open for a job that runs once a month.
  if (timer.unref) timer.unref();
  console.log('[site-maintenance] monthly per-site checks registered (hourly check for due policies; applies only what each site\'s policy allows).');
}
