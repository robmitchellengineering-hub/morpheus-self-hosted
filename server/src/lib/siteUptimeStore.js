// Where uptime observations live, and the two rules that keep the table honest.
//
//   1. IT IS PRUNED ON WRITE. One row per check grows at the polling rate forever;
//      an unbounded table is a cost nobody sees coming. RETAIN_DAYS is enforced here
//      rather than by a scheduled job, so the bound holds however the checks are
//      triggered.
//   2. A MISSING TABLE READS AS "NO HISTORY YET", NOT AS AN ERROR. The migration ships
//      with the code, and production applies additive SQL by hand — so the code runs
//      against a database that does not have this table for a while. That is hazard
//      H11's shape, and the smallest blast radius is to answer "we have not been
//      checking yet" rather than to throw on a page nobody expects to be broken by it.
import { prisma } from '../db.js';
import { RETAIN_DAYS } from './siteUptime.js';

const MISSING_TABLE = /does not exist|P2021|no such table|Unknown arg|relation .* does not exist/i;

/** Is this the "the migration has not been applied yet" error? */
export function isMissingUptimeTable(err) {
  return MISSING_TABLE.test(String(err?.message || err || ''));
}

/**
 * Record one observation and drop anything past the retention window.
 *
 * `checked_at` is set explicitly rather than left to the column default, because the
 * row is written AFTER the request completes and the time that matters is when the
 * request STARTED — a slow site must not look freshly checked by five seconds.
 */
export async function recordCheck({ projectId, userId, probe, latencyMs = 0, checkedAt = new Date() }) {
  try {
    const row = await prisma.siteUptimeCheck.create({
      data: {
        project_id: projectId,
        created_by_id: userId,
        checked_at: checkedAt,
        ok: !!probe.ok,
        status_code: Number(probe.status_code || 0),
        latency_ms: Math.max(0, Math.round(Number(latencyMs) || 0)),
        plugin_version: probe.plugin_version || null,
        error: probe.error ? String(probe.error).slice(0, 500) : null,
      },
    });
    await prune(projectId);
    return row;
  } catch (err) {
    if (isMissingUptimeTable(err)) return null; // not set up yet — see the header
    throw err;
  }
}

/** The checks still inside the window, OLDEST FIRST — the order `summarise()` needs. */
export async function recentChecks(projectId, days = RETAIN_DAYS) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    return await prisma.siteUptimeCheck.findMany({
      where: { project_id: projectId, checked_at: { gte: since } },
      orderBy: { checked_at: 'asc' },
      take: 5000,
      select: {
        checked_at: true, ok: true, status_code: true, latency_ms: true,
        plugin_version: true, error: true,
      },
    });
  } catch (err) {
    if (isMissingUptimeTable(err)) return [];
    throw err;
  }
}

/** Drop what is past the window. Best-effort: a prune failure must not fail a check. */
export async function prune(projectId, days = RETAIN_DAYS) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const { count } = await prisma.siteUptimeCheck.deleteMany({
      where: { project_id: projectId, checked_at: { lt: cutoff } },
    });
    return count;
  } catch (err) {
    if (isMissingUptimeTable(err)) return 0;
    // A prune is housekeeping; the observation that was just recorded is the point.
    return 0;
  }
}

/** Has the table been migrated? Used by the panel to say so rather than look empty. */
export async function uptimeReady() {
  try {
    await prisma.siteUptimeCheck.count({ take: 1 });
    return true;
  } catch (err) {
    if (isMissingUptimeTable(err)) return false;
    throw err;
  }
}
