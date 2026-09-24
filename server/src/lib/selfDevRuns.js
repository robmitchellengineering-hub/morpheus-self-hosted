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
// FAIL-SOFT, ALWAYS
//
// Recording is bookkeeping. A missing table (this deployment's migration applier
// has never run), a rejected insert, an unreachable read: every one of those
// loses the record and must never touch the pipeline. Every function here
// swallows its own errors, which is deliberate and is the opposite of the
// swallowing this codebase spent a week removing — the difference is that
// nothing downstream depends on this succeeding, and the caller's own result is
// unaffected either way. `isMissingRunsTable` exists so a caller CAN tell the
// two apart when it matters; nothing in the hot path does.
//
// Raw SQL rather than a Prisma model, matching lib/selfDevMigrations.js's
// `self_dev_migrations`: self-dev bookkeeping stays out of schema.prisma, and so
// out of the H11 blast radius (a listed entity with no `select` throws P2022 on
// a database that never had the column added).
import crypto from 'node:crypto';
import { prisma } from '../db.js';

/**
 * The functions whose execution is a stage of the self-dev pipeline, and the
 * short stage name each records under. Keyed by function name because that is
 * what the dispatcher knows; the stage name is what a reader sees.
 *
 * Anything not in this map is not recorded — this is a pipeline record, not a
 * request log, and turning every one of the ~120 functions into a row would
 * drown the useful signal.
 */
export const SELF_DEV_STAGES = {
  importSelfDevRepo: 'sync',
  chatWithMorpheus: 'chat',
  verifySelfDev: 'verify',
  pushSelfDevToGithub: 'push',
  mergeSelfDevPr: 'merge',
  smokeCheckSelfDev: 'smoke',
  revertSelfDevPush: 'revert',
  applySelfDevMigrations: 'migrate',
};

/** Detail is a note, not a payload: the schema caps nothing, so this does. */
export const MAX_DETAIL_CHARS = 1000;

/** A fresh run id, for a caller starting a run. */
export function newRunId() {
  return crypto.randomUUID();
}

/** Does this table exist yet on this deployment? */
export function isMissingRunsTable(err) {
  const m = err && typeof err.message === 'string' ? err.message : '';
  return err?.code === 'P2021'
    || /relation\s+"?self_dev_runs"?\s+does not exist/i.test(m)
    || /Cannot read properties of undefined \(reading '(create|findMany)/i.test(m);
}

/**
 * HTTP status → stage status. 4xx is `blocked` rather than `failed` on purpose:
 * a drift refusal, a scope refusal or a daily-cap refusal is the pipeline
 * working, and conflating "the guard stopped it" with "it broke" is how a
 * safety feature starts reading as a defect.
 */
export function statusForHttp(statusCode) {
  const code = Number(statusCode) || 0;
  if (code >= 200 && code < 400) return 'ok';
  if (code >= 400 && code < 500) return 'blocked';
  return 'failed';
}

/** Trim a detail note to the cap, preserving the note's shape. */
export function clampDetail(detail) {
  // Nothing to say is the empty string, not the two-character JSON encoding of
  // one — `typeof null === 'object'` sends null down the JSON path otherwise.
  if (detail === null || detail === undefined) return '';
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

/**
 * What is worth keeping out of a handler's return value.
 *
 * An allow-list, not a dump: these are the fields that answer "what did this
 * stage do" — the PR it opened, the files it moved, whether it was blocked and
 * why. A stage result also carries whole file lists and verification error
 * arrays, and storing those would turn a run record into a second copy of the
 * workspace.
 */
export function summariseResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const keep = [
    'ok', 'errorCount', 'checkedFiles', 'prNumber', 'prUrl', 'mode', 'commitSha', 'branch',
    'fileCount', 'createCount', 'updateCount', 'deleteCount', 'deletePaths',
    'merged', 'alreadyMerged', 'state', 'blocked', 'blockReason', 'reason',
    'failing', 'migrations', 'revertedToSha', 'applied', 'needsManual',
  ];
  const picked = {};
  for (const k of keep) {
    const v = result[k];
    if (v === undefined || v === null) continue;
    picked[k] = Array.isArray(v) ? v.slice(0, 8) : v;
  }
  return clampDetail(picked);
}

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
