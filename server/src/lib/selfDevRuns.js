// The self-dev run record — one row per pipeline stage, grouped by run id.
//
// WHY THIS EXISTS
//
// Every reason self-dev was untrustworthy last week came back to the same thing:
// a run left no durable trace. The merge, the deploy watch and the smoke check
// ran as effects inside SelfDev.jsx, so closing the tab ended the pipeline and
// the evidence went with it; verify results and deploy banners were React state;
// and the only surviving artefacts were chat messages asserting a deploy had
// happened. Answering "what did the last run actually do?" meant reading
// production tables by hand — the 2026-09-24 audit had to, and it is how a
// 3-in-17 revert rate and three never-executed capabilities were found at all.
//
// WHAT A ROW IS
//
// One row per stage (sync, chat, verify, push, merge, smoke …) sharing a
// `run_id`. Stages execute independently and some fail before the next is
// reached, so an append-only row per stage needs no read-modify-write — the same
// reasoning lib/selfDevDecisions.js uses.
//
// THIS FILE IS THE I/O HALF. The rules live in lib/selfDevRunRules.js, which has
// no imports beyond node:crypto — deliberately, because a script in CI's
// `guards (no install)` job cannot reach a package import, and it has to be able
// to test those rules.
//
// FAIL-SOFT, ALWAYS
//
// Recording is bookkeeping. A missing table (this deployment's migration applier
// has never run), a rejected insert, an unreachable read: every one of those
// loses the record and must never touch the pipeline. Every function here
// swallows its own errors, which is deliberate and is the opposite of the
// swallowing this codebase spent a week removing — the difference is that
// nothing downstream depends on this succeeding. `isMissingRunsTable` exists so
// a caller CAN tell the two apart when it matters; nothing in the hot path does.
//
// Raw SQL rather than a Prisma model, matching lib/selfDevMigrations.js's
// `self_dev_migrations`: self-dev bookkeeping stays out of schema.prisma, and so
// out of the H11 blast radius (a listed entity with no `select` throws P2022 on
// a database that never had the column added).
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import {
  SELF_DEV_STAGES, MAX_DETAIL_CHARS, newRunId, isMissingRunsTable,
  statusForHttp, clampDetail, summariseResult,
} from './selfDevRunRules.js';

// Re-exported so a caller has one place to import from; the rules themselves
// are defined in the dependency-free module so a no-install guard can reach them.
export {
  SELF_DEV_STAGES, MAX_DETAIL_CHARS, newRunId, isMissingRunsTable,
  statusForHttp, clampDetail, summariseResult,
};

/**
 * Record one stage. Never throws, never awaited on the hot path.
 *
 * `runId` is the caller's, so the stages of one run group together across
 * separate HTTP calls — the CLI holds one for a whole sync → chat → push →
 * merge sequence. A caller with no run id gets a fresh one, which makes its
 * stage a run of one rather than losing it.
 */
export async function recordStage({ runId, fn, status, durationMs = null, detail = '', userId = null } = {}) {
  const stage = SELF_DEV_STAGES[fn];
  if (!stage) return false;
  try {
    await prisma.$executeRawUnsafe(
      'insert into self_dev_runs (id, run_id, created_by_id, stage, status, detail, duration_ms) values ($1, $2, $3, $4, $5, $6, $7)',
      crypto.randomUUID(), String(runId || newRunId()), userId ? String(userId) : null, stage, String(status || 'ok'),
      clampDetail(detail), Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    );
    return true;
  } catch (err) {
    // Loud enough to find in the logs, quiet enough to be harmless.
    console.warn(`[selfDevRuns] not recorded (${stage}): ${err?.message || err}`);
    return false;
  }
}

/**
 * The most recent runs for one account, newest first, with their stages grouped.
 *
 * Scoped by owner, like every other self-dev lookup — a run record that leaked
 * another admin's activity would be the same class of mistake as the unscoped
 * self-dev lookup buildDeckWidget.js had to fix.
 *
 * Returns `{ available: false, reason }` when the table is missing rather than
 * an empty list — "no record" and "no runs" are different answers and the whole
 * point of this module is that the difference is legible.
 */
export async function recentRuns(userId, limit = 5) {
  const take = Math.min(Math.max(Number(limit) || 5, 1), 25);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `select run_id, stage, status, detail, duration_ms, created_date
         from self_dev_runs
        where created_by_id = $1
          and run_id in (
            select run_id from self_dev_runs where created_by_id = $1
             group by run_id order by max(created_date) desc limit $2
          )
        order by created_date asc`,
      userId ? String(userId) : '', take,
    );
    const byRun = new Map();
    for (const r of rows) {
      if (!byRun.has(r.run_id)) byRun.set(r.run_id, []);
      byRun.get(r.run_id).push({
        stage: r.stage,
        status: r.status,
        detail: r.detail || '',
        durationMs: r.duration_ms,
        at: r.created_date instanceof Date ? r.created_date.toISOString() : String(r.created_date),
      });
    }
    return { available: true, runs: [...byRun.entries()].map(([runId, stages]) => ({ runId, stages })).reverse() };
  } catch (err) {
    return { available: false, reason: isMissingRunsTable(err) ? 'the self_dev_runs table does not exist on this deployment' : String(err?.message || err) };
  }
}
