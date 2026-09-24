// The pure rules behind the self-dev run record.
//
// Split out of selfDevRuns.js for one specific reason: that module talks to
// Prisma, and a script in CI's `guards (no install)` job cannot reach a package
// import — transitively or otherwise. scripts/verify-selfdev-runs.mjs has to
// exercise these rules, so they live where a no-install script can import them
// and nothing else does. Same shape as deckDumpClassify / prodSqlGuard /
// billingClamp, and the same reasoning lib/requiredChecks.js and
// selfDevDrift.js's evaluator are written to.
//
// Nothing here touches the database, the network, or the environment. The
// dependency-free-ness IS the feature: a rule that can be tested with no
// install is a rule that gets tested on every pull request.
import crypto from 'node:crypto';

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
    'rework',
  ];
  const picked = {};
  for (const k of keep) {
    const v = result[k];
    if (v === undefined || v === null) continue;
    picked[k] = Array.isArray(v) ? v.slice(0, 8) : v;
  }
  return clampDetail(picked);
}
