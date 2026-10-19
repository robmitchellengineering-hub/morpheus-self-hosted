// Write generated files as they are produced, so a failure leaves the work that succeeded.
//
// WHY THIS EXISTS. `generateBackend` deleted every existing backend file and then wrote the new set in ONE
// `createMany` at the very end. Three separate things went wrong with that on 2026-09-29/30, and every one
// of them cost real credits:
//
//   * a coder chunk hit the token cap and threw — five successful model calls discarded, the project left
//     with nothing but its plan;
//   * the coder answered with a JSON schema instead of files — same loss;
//   * the reviewer ran twelve times and never converged — same loss, ~473 credits.
//
// The truncation and the loop are fixed. This is the third leg: NOTHING was persisted until the whole
// generation finished, so any failure anywhere discarded everything before it. A long, expensive operation
// that keeps nothing on failure is the property that turned each of those from an inconvenience into a
// total loss.
//
// WHAT IT WRITES, AND WHAT IT DELIBERATELY DOES NOT DO.
//
//   * A new file is written as soon as it exists, so a crash keeps it.
//   * A file that already exists is replaced with the new content, never deleted first — so a run that
//     dies halfway leaves the OLD working version rather than a hole. The delete-then-write order was the
//     worst of both: it removed the previous working backend and only then started producing the one that
//     might never arrive.
//   * Paths are normalised and de-duplicated, because the reviewer's retry can return both
//     `api/routes.js` and `backend/api/routes.js` for the same file.
//   * A generation that fails is REPORTED as partial, with the files that did land and the ones that did
//     not. Silence here would leave an operator with a half-backend, no indication, and a first command
//     that fails for reasons nothing explains.
//
// This module is the decision — which paths to write, which to leave, which are stale — as pure functions
// over a small `store` interface, so it can be asserted without a database or a model. The caller supplies
// `store.writeFile({ path, content, language })`, `store.deleteByPath(path)` and `store.existingPaths()`.

/**
 * Normalise a generated path to its stored form: always `backend/…`, no `./`, no doubled separator.
 *
 * The prefix is the whole reason this is a function: the coder is told to return paths WITHOUT the
 * `backend/` prefix, the reviewer sometimes adds it back, and both name the same file. Treating them as
 * two is how a generation writes the same module twice and which copy wins depends on iteration order.
 */
export function normalizeBackendPath(path) {
  const raw = String(path || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
  if (!raw) return '';
  return raw.startsWith('backend/') ? raw : `backend/${raw}`;
}

/**
 * The write plan for a batch of generated operations.
 *
 * `writes` is de-duplicated last-wins, which is what a filesystem would do and what the previous
 * `createMany` was emulating with its own Map. Order is preserved by first appearance so the plan reads
 * like the generation ran.
 */
export function planWrites(fileOps) {
  const byPath = new Map();
  for (const op of fileOps || []) {
    if (!op || typeof op.path !== 'string') continue;
    if (op.action === 'delete') { byPath.delete(normalizeBackendPath(op.path)); continue; }
    const path = normalizeBackendPath(op.path);
    if (!path) continue;
    byPath.set(path, {
      path,
      // Non-nullable column, and the model does not always fill it — a generated `.env.example` arrived
      // with no content at all on 2026-09-29. Coerce rather than pass undefined through; the previous
      // all-or-nothing write turned that one missing field into the loss of every file in the batch.
      content: typeof op.content === 'string' ? op.content : '',
    });
  }
  return { writes: [...byPath.values()] };
}

/**
 * Which previously stored backend files this run did NOT produce, and are therefore stale.
 *
 * `.plan.json` is always kept: it is the plan the generation was driven by, not an output of it, and
 * deleting it would break the next `generateBackend` call ("No backend plan found").
 */
export function staleBackendPaths(existingPaths, writtenPaths) {
  const written = new Set((writtenPaths || []).map(normalizeBackendPath).filter(Boolean));
  const keep = new Set(['backend/.plan.json']);
  return (existingPaths || [])
    .map(normalizeBackendPath)
    .filter((p) => p && !written.has(p) && !keep.has(p));
}

/**
 * Write a batch, one file at a time, reporting what landed.
 *
 * A file that fails to write does NOT abort the rest: the point of this function is that a partial result
 * is worth keeping, and one unwritable path (a constraint, a transient error) is no reason to drop the
 * others. Failures are returned so the caller can say so.
 */
export async function persistIncrementally({ writes, store }) {
  const written = [];
  const failed = [];
  for (const w of writes || []) {
    try {
      await store.writeFile(w);
      written.push(w.path);
    } catch (err) {
      failed.push({ path: w.path, reason: (err && err.message) || String(err) });
    }
  }
  return { written, failed };
}

/**
 * Remove files this run did not produce. Called only AFTER a run that got far enough to be worth trusting
 * with a delete — see the caller for why that ordering matters.
 */
export async function removeStale({ paths, store }) {
  const removed = [];
  const failed = [];
  for (const path of paths || []) {
    try {
      await store.deleteByPath(path);
      removed.push(path);
    } catch (err) {
      failed.push({ path, reason: (err && err.message) || String(err) });
    }
  }
  return { removed, failed };
}

/**
 * What the operator is owed when a generation did not finish.
 *
 * A half-written backend that says nothing is worse than one that says what is missing: the next command
 * fails, and nothing explains why. This is the sentence that makes a partial run actionable.
 */
export function partialRunNote({ written = [], failed = [], total = null, reason = null }) {
  const shortfall = total == null ? 0 : Math.max(0, total - written.length);
  // NOTHING TO SAY WHEN NOTHING IS WRONG. A complete run has saved files too, and the first version
  // reported "1 file(s) were generated and saved … the backend is INCOMPLETE" for it — a warning on
  // every success, which is how a real warning stops being read.
  const incomplete = failed.length > 0 || shortfall > 0 || Boolean(reason);
  if (!incomplete) return null;

  const parts = [];
  if (written.length > 0) parts.push(`${written.length} file(s) were generated and saved`);
  if (failed.length > 0) parts.push(`${failed.length} could not be saved (${failed.map((f) => f.path).join(', ')})`);
  if (shortfall > 0) parts.push(`${shortfall} of ${total} planned file(s) were never produced`);
  return `${parts.join('; ')}${reason ? ` — ${reason}` : ''}. The backend is INCOMPLETE: ` +
    'the files listed as saved are on disk and reviewable, and the rest still need generating. Ask again to continue.';
}
