// The monthly site check — the SAFE half of site maintenance.
//
// This runs a scan and writes a report. It applies NOTHING. That is not a
// limitation of effort: applying updates writes to someone's live site and needs
// a pre-update snapshot and a post-update check before it can be offered, and the
// owner's policy for it has not been set. A scheduled job that changed sites
// without those would be the worst thing this feature could do.
//
// `mayApply` in lib/siteMaintenance.js already encodes the policy that will gate
// applying when it exists, including the one rule that is not configurable — a
// major core update is never automatic — so the rules are settled before the
// ability arrives, not after.
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
    let error = null;
    try {
      scan = await scanSite({ id: policy.created_by_id }, policy.project_id, { force: true });
    } catch (err) {
      error = err.message;
    }

    // The report goes to the construct's chat, where the owner already is —
    // an unattended run that reports nowhere is not a report.
    const content = error
      ? `Scheduled site check for ${project.name} could not run: ${error}`
      : runSummary({ scan, policy, applied: [], failed: [], skipped: scan.update_plan.total ? ['all available updates (applying is off)'] : [] });
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
          // Spelled out so a later reader can tell a scan-only run from an
          // apply run without reading the code.
          applied: [],
        },
    });

    outcomes.push({ projectId: policy.project_id, status: error ? 'error' : 'scanned', error });
    log.log?.(`[site-maintenance] ${project.name}: ${error ? `failed — ${error}` : `scanned: ${scan.summary.headline}`}`);
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
  console.log('[site-maintenance] monthly per-site checks registered (hourly check for due policies, scan only).');
}
