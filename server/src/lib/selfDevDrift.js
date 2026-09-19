// H9 drift guard — refusing to ship a stale self-dev workspace.
//
// WHY THIS EXISTS
//
// Self-dev's workspace is a MIRROR of morpheus-self-hosted@main. The ship engine
// (lib/engine/ship.js) diffs the local ProjectFile rows against the LIVE remote
// tree by git-blob SHA and treats every remote path absent locally as a
// DELETION. So a workspace that has fallen behind main does not merely miss
// upstream work — it actively deletes it on the next push.
//
// That is incident H9 (2026-09-11): while self-dev's workspace sat stale, a
// separate writer merged roughly a dozen PRs to main. The next push computed its
// diff against the stale snapshot and "corrected" main back toward it — ~45
// files removed, including `blockWidget`, a shipped security fix.
//
// The mitigations already in place (PR-by-default, scoped pushes,
// exclusion-gated deletions, truncated-tree bail-out) all reduce the blast
// radius, but none of them can tell that the workspace is stale. This module
// supplies the missing check.
//
// THE CHECK
//
// `Project.synced_commit` records the branch HEAD the workspace was last synced
// from (or successfully pushed to). Comparing it against main's live HEAD is the
// root-cause test: equal means the mirror is current, different means the
// workspace is stale and a push must not proceed.
//
// A second, independent net covers workspaces that predate the column (or whose
// marker was lost): a single unscoped push deleting an unusual number of files
// is treated as drift rather than intent. A normal self-dev change deletes 0-3
// files; H9 deleted ~45.

/**
 * Deletions above this in one unscoped push are treated as drift, not intent.
 * Set well above any normal change (0-3) and well below H9's ~45, so a
 * deliberate large refactor is a rare, explicit `force` rather than a silent
 * accident.
 */
export const MAX_UNSCOPED_DELETIONS = 10;

const STALE_MESSAGE = (synced, remote) =>
  `Push blocked — the self-dev workspace mirrors ${String(synced).slice(0, 7)} but main is now at `
  + `${String(remote).slice(0, 7)}. Continuing would diff against a stale snapshot and delete whatever `
  + `landed upstream since (this is incident H9 — KNOWN-HAZARDS.md). Click SYNC FROM GITHUB, re-apply `
  + `your change, then push again — or push with force to override.`;

const EXCESS_MESSAGE = (deleteCount) =>
  `Push blocked — this change would delete ${deleteCount} files from production. That is not a normal `
  + `self-dev change (0-3 deletions is typical) and matches the shape of incident H9, where a stale `
  + `workspace removed ~45 unrelated files. If this is genuinely intended, push with force; otherwise `
  + `click SYNC FROM GITHUB and re-apply your change.`;

/**
 * Decide whether a prospective self-dev push should be refused.
 *
 * Pure: no I/O, no Prisma. Callers supply the two facts it needs, which keeps it
 * directly testable against real values.
 *
 * @param {object} input
 * @param {string|null|undefined} input.syncedCommit  Project.synced_commit
 * @param {string|null|undefined} input.remoteHead    current HEAD of the base branch
 * @param {number} [input.deleteCount]                deletions this push would make
 * @param {boolean} [input.scoped]                    the push is policy-scoped (widget build/delete)
 * @param {boolean} [input.directToMain]              the explicit force/direct-to-main path
 * @returns {{reason: string, message: string}|null}  null = allow
 */
export function evaluateDrift({ syncedCommit, remoteHead, deleteCount = 0, scoped = false, directToMain = false } = {}) {
  // An explicit operator override is not something to second-guess — this
  // matches the schema gate's existing `force` convention. `directToMain` is
  // only reachable via force or an explicit body flag.
  if (directToMain) return null;

  // A policy-scoped push (widget build / widget delete) cannot diff or delete
  // outside its own allow-list, so drift cannot make it remove unrelated files.
  if (scoped) return null;

  // 1. Root cause: a recorded sync point that does not match main's current HEAD
  //    means the mirror is stale.
  if (syncedCommit && remoteHead && syncedCommit !== remoteHead) {
    return { reason: 'stale-workspace', message: STALE_MESSAGE(syncedCommit, remoteHead) };
  }

  // 2. Independent net, and the only available check for a workspace whose sync
  //    point is null (pre-migration, or lost).
  const deletions = Number(deleteCount) || 0;
  if (deletions > MAX_UNSCOPED_DELETIONS) {
    return { reason: 'excess-deletions', message: EXCESS_MESSAGE(deletions) };
  }

  return null;
}

/**
 * Does this error mean the synced_commit column does not exist yet?
 *
 * The column ships ahead of its migration, the same way self_dev_decisions and
 * self_dev_features do (see lib/selfDevFeature.js's isMissingFeaturesTable).
 * Until server/prisma/selfdev-add-synced-commit.sql is run, any Prisma call
 * selecting this field throws — so callers must degrade to "unknown sync point"
 * rather than fail the whole request.
 */
export function isMissingSyncedCommitColumn(err) {
  const m = err && typeof err.message === 'string' ? err.message : '';
  return err?.code === 'P2022' // Prisma: column does not exist
    || /column\s+"?projects"?\.?"?synced_commit"?\s+does not exist/i.test(m)
    || /column\s+`?synced_commit`?\s+does not exist/i.test(m)
    || /The column `projects\.synced_commit` does not exist/i.test(m);
}
