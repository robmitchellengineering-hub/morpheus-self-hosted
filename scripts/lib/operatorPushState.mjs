// The push → merge handoff for scripts/morpheus.mjs.
//
// WHY THIS EXISTS
//
// `push` and `merge` are two separate CLI invocations, and mergeSelfDevPr.js
// needs two facts about the pushed change that the operator never types:
// whether it carries a server/prisma/selfdev-*.sql migration to apply, and
// whether it touched the manual's source. pushSelfDevToGithub.js already
// returns both in its PR-mode response (`hasMigration`, `touchedManualSource`).
// The browser path forwards them in memory (SelfDev.jsx's prWatch,
// buildDeckWidget.js and deleteDeckWidget.js call sites); a CLI has no memory
// between processes, so the fact has to be written to disk.
//
// Without it, mergeSelfDevPr.js's defaults (hasMigration = false) mean the
// documented `push` → `merge` loop ships a migration into the repo, deploys
// code that expects the new schema, and never runs the DDL — the exact failure
// this module exists to prevent.
//
// Pure, so the carry rule is testable with no network and no running server
// (scripts/verify-operator-drive.mjs exercises it); the CLI owns the file I/O.
//
// NOT a privilege. hasMigration is not one of OPERATOR_FORBIDDEN_FIELDS and
// mergeSelfDevPr is already in OPERATOR_SCOPE_FUNCTIONS, so a hand-rolled
// operator request could already set it — this only makes the CLI send the
// truth instead of dropping it. It adds no escape hatch and never names
// force / directToMain / acknowledgeDrift / scopePolicy.

/** What `push` should persist for a PR-mode push, or null when there is no PR. */
export function pushRecord(body) {
  const prNumber = Number(body?.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
  return {
    prNumber,
    hasMigration: body?.hasMigration === true,
    touchedManualSource: body?.touchedManualSource === true,
  };
}

/**
 * The body fields `merge <prNumber>` should add, given the persisted record.
 *
 * Empty unless the record is for THIS PR. A stale record must never lend its
 * migration to a different PR's merge — that would run DDL the merge never
 * shipped. When it matches, both flags are sent with the push's own answer
 * (true or false) rather than left to a default.
 */
export function carriedFlags(record, prNumber) {
  const n = Number(prNumber);
  if (!record || !Number.isInteger(n) || n <= 0 || Number(record.prNumber) !== n) return {};
  return {
    hasMigration: record.hasMigration === true,
    touchedManualSource: record.touchedManualSource === true,
  };
}
