// Did an operation actually write anything?
//
// WHY THIS EXISTS (defect 4, 2026-09-30). `appliedOps` is a MIXED list: `server/src/lib/projectUtils.js`
// pushes real writes alongside refusals and skips —
//
//   wrote:      create, update, delete
//   did NOT:    policy_denied, skipped_fake_binary, skipped_no_content, edit_failed, apply_failed
//
// — and five separate places re-derived which is which, THREE of them wrongly:
//
//   * `chatWithMorpheus.js` counted the polish pass correctly (only create/update/delete);
//   * `EmbedChat.jsx` filtered only `skipped_fake_binary`, so a refused file, a skipped-empty file and a
//     failed edit all counted as "this build changed…";
//   * `useWorkspace.js` filtered NOTHING, so after a build where every operation was refused the workspace
//     still reloaded and highlighted each refused path as just-touched.
//
// That last one is the same lie in the opposite direction from defect 9: not "a file that exists is
// missing", but "a file that was never written has changed". One definition, published in the payload, so
// no consumer has to know the vocabulary.
//
// Pure and import-free so scripts/verify-applied-ops.mjs can test it without an install.

/** Actions that changed the project on disk. The whole point of this module is that this list is written ONCE. */
export const APPLIED_ACTIONS = ['create', 'update', 'delete'];

/** Actions that failed or were skipped, carried in the same list so the caller can report them. */
export const UNRESOLVED_ACTIONS = ['edit_failed', 'apply_failed'];

/**
 * Did this operation change the project? True for a write, false for a refusal, a skip or a failure.
 *
 * Deliberately an ALLOW-list: a future action nobody has thought of yet must not be counted as a write,
 * because the failure that way round is "we told the operator a file changed when it did not".
 */
export function isAppliedOp(op) {
  return APPLIED_ACTIONS.includes(String(op?.action));
}

/** Wrote or overwrote CONTENT — a delete does not, and the distinction matters where prose is generated. */
export function isContentOp(op) {
  return String(op?.action) === 'create' || String(op?.action) === 'update';
}

export function appliedOnly(ops) {
  return (ops || []).filter(isAppliedOp);
}

/** The paths that actually changed, in order, without duplicates. What a UI should highlight. */
export function appliedPaths(ops) {
  return [...new Set(appliedOnly(ops).map((op) => op?.path).filter(Boolean))];
}

export function appliedCount(ops) {
  return appliedOnly(ops).length;
}

/** Paths whose operation failed and still needs resolving — a different question from "what changed". */
export function unresolvedPaths(ops) {
  return [...new Set((ops || [])
    .filter((op) => UNRESOLVED_ACTIONS.includes(String(op?.action)))
    .map((op) => op?.path)
    .filter(Boolean))];
}
