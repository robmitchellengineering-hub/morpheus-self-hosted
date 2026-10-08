// Check the connected sites on a schedule, so the history exists even when nobody is
// looking — which is the entire point of uptime monitoring.
//
// TWO MODES, copying freshnessSchedule.js exactly, because the reasoning is the same:
//   * no REDIS_URL (the default self-host, one process): an in-process interval is
//     fine — there is only ever one process to run it;
//   * REDIS_URL set (several API replicas): an interval in every replica would mean N
//     duplicate checks and N rows per interval, so this backs off and worker.js
//     registers a single repeatable job instead — once, however many replicas exist.
//
// WHY A DUE-CHECK RATHER THAN "CHECK EVERYTHING EVERY TICK": the interval is a floor,
// not a metronome. A tick asks which sites have not been checked for longer than the
// interval and checks those, so a restart, a missed tick or a manual CHECK NOW in the
// panel never produces a burst of duplicate observations — and one flaky site (a slow
// DNS lookup, a host that hangs) delays only its own turn.
import { queueEnabled } from './queue.js';
import { prisma } from './db.js';
import { wpStatus, normalizeSiteUrl } from './lib/wpPlugin.js';
import { classifyProbe } from './lib/siteUptime.js';
import { recordCheck, latestCheckAt } from './lib/siteUptimeStore.js';

export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // five minutes
const FIRST_RUN_DELAY_MS = 90 * 1000;             // let the server finish booting
/** Per tick, so one tick cannot become an unbounded outbound fan-out. */
export const MAX_PER_TICK = 25;
/** A single site cannot hold a tick open forever. */
const PROBE_TIMEOUT_MS = 15000;

function intervalMs() {
  return Number(process.env.SITE_UPTIME_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
}

/** Every connected WordPress site, whatever account owns it. */
async function connectedSites() {
  try {
    return await prisma.pluginConnection.findMany({
      where: { kind: 'wordpress' },
      select: { project_id: true, created_by_id: true, site_url: true },
      take: 500,
    });
  } catch (err) {
    // No table / no schema yet is not a reason to crash a schedule.
    return [];
  }
}

/**
 * Check every site that is due, oldest first.
 *
 * Exported so it can be driven directly (a test, a manual trigger) without waiting for
 * the clock. Returns what it did, per site — including the ones it skipped and why.
 */
export async function runDueUptimeChecks(now = Date.now(), { log = console } = {}) {
  const sites = await connectedSites();
  const due = [];

  for (const site of sites) {
    const last = await latestCheckAt(site.project_id);
    const lastMs = last ? Date.parse(last) : 0;
    if (!lastMs || (now - lastMs) >= intervalMs()) due.push({ site, lastMs });
  }

  due.sort((a, b) => a.lastMs - b.lastMs); // the longest-unchecked first
  const batch = due.slice(0, MAX_PER_TICK);
  const outcomes = [];

  for (const { site } of batch) {
    const startedAt = new Date();
    const t0 = Date.now();
    try {
      const res = await Promise.race([
        wpStatus(normalizeSiteUrl(site.site_url)),
        new Promise((resolve) => setTimeout(() => resolve({ status: 0, error: 'timed out' }), PROBE_TIMEOUT_MS)),
      ]);
      const probe = classifyProbe(res);
      const latency = Date.now() - t0;
      await recordCheck({
        projectId: site.project_id,
        userId: site.created_by_id,
        probe,
        latencyMs: latency,
        checkedAt: startedAt,
      });
      outcomes.push({ projectId: site.project_id, ok: probe.ok, statusCode: probe.status_code, latencyMs: latency });
    } catch (err) {
      // One site's failure is that site's row (recorded above where possible), never
      // the whole tick's. A schedule that dies on the first bad host monitors nothing.
      log.warn?.(`[uptime] check failed for ${site.project_id}: ${err.message}`);
      outcomes.push({ projectId: site.project_id, ok: false, error: err.message });
    }
  }

  if (outcomes.length) {
    const down = outcomes.filter((o) => !o.ok).length;
    log.log?.(`[uptime] checked ${outcomes.length} site(s)${down ? `, ${down} not answering` : ''}.`);
  }
  return { checked: outcomes.length, due: due.length, skipped: Math.max(0, due.length - batch.length), outcomes };
}

/**
 * The in-process half. No-op when Redis is configured — worker.js owns the schedule
 * then, and running it here as well would double every observation.
 */
export function startSiteUptimeSchedule() {
  if (queueEnabled()) {
    console.log('[uptime] REDIS_URL is set — scheduled via the worker process (see worker.js) instead of here.');
    return;
  }
  if (process.env.SITE_UPTIME_ENABLED === 'false') {
    console.log('[uptime] disabled via SITE_UPTIME_ENABLED=false.');
    return;
  }

  const every = intervalMs();
  const run = () => {
    runDueUptimeChecks()
      .then(({ checked, skipped }) => {
        if (!checked && !skipped) return; // nothing connected, nothing to say
      })
      .catch((err) => console.warn('[uptime] schedule tick failed:', err.message));
  };

  setTimeout(() => {
    run();
    setInterval(run, every).unref();
  }, FIRST_RUN_DELAY_MS).unref();

  console.log(`[uptime] scheduled — first check in ~${Math.round(FIRST_RUN_DELAY_MS / 1000)}s, then every ${Math.round(every / 60000)}m.`);
}
