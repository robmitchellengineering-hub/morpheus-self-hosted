// Sync safety — keeping un-pushed local work through a SYNC FROM GITHUB.
//
// THE BUG THIS EXISTS FOR (demonstrated 2026-09-24, not reasoned about)
//
// The H9 drift guard refuses a stale push and tells the operator: "Click SYNC
// FROM GITHUB, re-apply your change, then push again." Running that sync deleted
// the new file and reverted the edited one; the next push said "No changes to
// push — workspace already matches production." The recovery the guard
// recommends destroys the change it tells you to re-apply.
//
// THE SECOND BUG, FOUND BY WALKING INTO IT (2026-09-24, later)
//
// The first fix REFUSED the sync whenever anything was at risk. That is correct
// in isolation and useless in practice, because it deadlocks the pipeline: a
// stale mirror makes the push refuse, un-pushed work makes the sync refuse, and
// the only way out is to discard the work. The operator is stuck between two
// guards, both of which are right.
//
// So the sync PRESERVES rather than refuses. It fetches everything upstream
// changed, keeps the files that carry local work, keeps files that exist only
// here, advances the sync point to the new HEAD, and says what it kept. The
// workspace is then genuinely based on the new HEAD with local edits on top —
// which is exactly what the subsequent push wants to carry.
//
// WHY IT STILL NEEDS PROVENANCE
//
// Overwriting is right for a mirror catching up and wrong for work in progress,
// and "local sha differs from remote" describes both. `project_files.synced_sha`
// — the upstream blob sha a row was last known to correspond to — separates them,
// and separates a further case that matters:
//
//   upstream unchanged, local edited   -> a local-only edit; keep silently
//   BOTH changed since the last sync   -> a conflict; keep, and say so
//   not upstream at all, never was     -> a new file; keep
//   upstream deleted, local untouched  -> drop it, that is the mirror's job
//
// The conflict case is the one the earlier design could not express, and it is
// the one with consequences: preserving a conflict and then pushing it WILL
// overwrite upstream's version of that file. That has to be said out loud rather
// than discovered.
//
// Pure by design — no database, no network, no environment — so the rule that
// decides whether someone's work survives can be tested with no install, which
// is the same reason lib/selfDevRunRules.js and lib/selfDevDrift.js's evaluator
// are pure.
import { gitBlobSha } from './selfDevRepo.js';

/**
 * What a sync would do to local work, path by path.
 *
 * @param {object} input
 * @param {Array<{path: string, content: string}>} input.local   workspace rows
 * @param {Array<{path: string, sha: string}>} input.remote      upstream tree (excluded paths already filtered)
 * @param {Map<string,string|null>} [input.syncedShaByPath]       provenance per path
 */
export function assessLocalLoss({ local = [], remote = [], syncedShaByPath } = {}) {
  const provenance = syncedShaByPath instanceof Map ? syncedShaByPath : new Map();
  const remoteShaByPath = new Map(remote.map((r) => [r.path, r.sha]));
  const modified = [];   // local edit, upstream did not touch it
  const conflicts = [];  // both changed — keeping local overwrites upstream on push
  const orphaned = [];   // exists only here
  const deletions = [];  // upstream removed it and nobody edited it: safe to drop

  for (const file of local) {
    const localSha = gitBlobSha(file.content ?? '');
    const remoteSha = remoteShaByPath.get(file.path);
    const synced = provenance.get(file.path) ?? null;

    if (remoteSha === undefined) {
      // Gone upstream. With provenance proving we hold an untouched copy of what
      // upstream had, this is upstream's deletion and the mirror should follow.
      // Otherwise it cannot be shown to have come from upstream at all, so it is
      // kept — which is the case that actually lost work.
      if (synced !== null && localSha === synced) deletions.push(file.path);
      else orphaned.push(file.path);
      continue;
    }

    if (remoteSha === localSha) continue;                  // already current
    if (synced !== null && localSha === synced) continue;  // untouched: plain catch-up
    // Unknown provenance is treated as catch-up, not as local work. Every row
    // predating the column has none, so treating it as "edited" would make the
    // first sync on any existing deployment preserve all 242 drifted files and
    // never catch up. Overwriting an unknown file is the normal path; DELETING
    // one is the case that cannot be undone, and that is handled above.
    if (synced === null) continue;

    if (remoteSha === synced) modified.push(file.path);
    else conflicts.push(file.path);
  }

  return {
    modified, conflicts, orphaned, deletions,
    preserved: modified.length + conflicts.length + orphaned.length,
  };
}

/**
 * Turn an assessment into what the sync should actually do.
 *
 * `skipFetch` — do not pull upstream's version over this path. `skipDelete` — do
 * not remove it. Both are local work being kept.
 *
 * `acceptLocalLoss` is the deliberate discard and the ONLY way to get the old
 * behaviour: it skips nothing, and reports exactly what it is about to destroy,
 * so the destructive path is a decision rather than a surprise.
 */
export function planSync({ assessment, acceptLocalLoss = false } = {}) {
  const a = assessment || {};
  const preserved = {
    modified: a.modified || [],
    conflicts: a.conflicts || [],
    orphaned: a.orphaned || [],
  };
  if (acceptLocalLoss) {
    return {
      skipFetch: [],
      skipDelete: [],
      preserved: { modified: [], conflicts: [], orphaned: [] },
      discarding: [...preserved.modified, ...preserved.conflicts, ...preserved.orphaned],
    };
  }
  return {
    skipFetch: [...preserved.modified, ...preserved.conflicts],
    skipDelete: [...preserved.orphaned],
    preserved,
    discarding: [],
  };
}

/**
 * What to tell the operator afterwards.
 *
 * Names the files, and names conflicts separately: those are the ones that will
 * overwrite an upstream change when pushed, which is worth knowing before
 * pushing rather than after.
 */
export function syncPreservedMessage(preserved = {}) {
  const listed = (list) => `${list.slice(0, 8).join(', ')}${list.length > 8 ? ', …' : ''}`;
  const parts = [];
  if (preserved.modified?.length) parts.push(`${preserved.modified.length} kept local edit(s): ${listed(preserved.modified)}`);
  if (preserved.orphaned?.length) parts.push(`${preserved.orphaned.length} file(s) that exist only here: ${listed(preserved.orphaned)}`);
  if (preserved.conflicts?.length) {
    parts.push(`${preserved.conflicts.length} CONFLICT(s) changed both here and upstream, so pushing will overwrite the upstream version: ${listed(preserved.conflicts)}`);
  }
  if (!parts.length) return '';
  return `Sync kept un-pushed work rather than overwriting it. ${parts.join('. ')}.`;
}
