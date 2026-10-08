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
//
//      ⚠️ AND "MISSING" HAS TWO FORMS, which the first version of this file did not
//      know. A missing TABLE is the migration not applied yet. A missing MODEL — with
//      no error at all, because `prisma.siteUptimeCheck` is simply `undefined` when the
//      generated client predates the schema — is the client not regenerated yet. Both
//      mean the same thing to an operator, and the second one CRASHED the panel with
//      "Cannot read properties of undefined (reading 'count')" in a real browser before
//      the delegate check below existed. Reading a property off a delegate that may not
//      exist is the bug; asking first is the fix.
import { prisma } from '../db.js';
import { RETAIN_DAYS } from './siteUptime.js';

const MISSING_TABLE = /does not exist|P2021|no such table|Unknown arg|relation .* does not exist/i;

/** Is this the "the migration has not been applied yet" error? */
export function isMissingUptimeTable(err) {
  return MISSING_TABLE.test(String(err?.message || err || ''));
}

/**
 * The Prisma delegate for this model, or null when the generated client predates it.
 *
 * Public so the guard can assert that every read and write in this file asks first.
 */
export function uptimeDelegate() {
  return prisma.siteUptimeCheck || null;
}

/**
 * Record one observation and drop anything past the retention window.
 *
 * `checked_at` is set explicitly rather than left to the column default, because the
 * row is written AFTER the request completes and the time that matters is when the
 * request STARTED — a slow site must not look freshly checked by five seconds.
 */
export async function recordCheck({ projectId, userId, probe, latencyMs = 0, checkedAt = new Date() }) {
  const db = uptimeDelegate();
  if (!db) return null; // client not regenerated yet — see the header
  try {
    const row = await db.create({
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
  const db = uptimeDelegate();
  if (!db) return [];
  try {
    return await db.findMany({
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
  const db = uptimeDelegate();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const { count } = await db.deleteMany({
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
  const db = uptimeDelegate();
  if (!db) return false;
  try {
    await db.count({ take: 1 });
    return true;
  } catch (err) {
    if (isMissingUptimeTable(err)) return false;
    throw err;
  }
}

/**
 * When this project was last checked, or null.
 *
 * Read by the schedule to decide what is DUE — which is why it is its own query rather
 * than fetching the history: the schedule runs for every connected site on every tick,
 * and pulling a month of rows to look at one timestamp is a cost that grows with how
 * long the product has been running.
 */
export async function latestCheckAt(projectId) {
  const db = uptimeDelegate();
  if (!db) return null;
  try {
    const row = await db.findFirst({
      where: { project_id: projectId },
      orderBy: { checked_at: 'desc' },
      select: { checked_at: true },
    });
    return row?.checked_at ? new Date(row.checked_at).toISOString() : null;
  } catch (err) {
    if (isMissingUptimeTable(err)) return null;
    throw err;
  }
}
