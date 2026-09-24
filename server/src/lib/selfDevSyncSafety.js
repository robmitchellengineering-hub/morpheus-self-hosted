// Sync safety — telling an upstream change apart from un-pushed local work.
//
// THE BUG THIS EXISTS FOR (demonstrated 2026-09-24, not reasoned about)
//
// The H9 drift guard refuses a stale push and tells the operator: "Click SYNC
// FROM GITHUB, re-apply your change, then push again." Running that sync deleted
// the new file and reverted the edited one; the next push said "No changes to
// push — workspace already matches production." The recovery the guard
// recommends destroys the change it tells you to re-apply.
//
// WHY IT COULD NOT TELL
//
// `importSelfDevRepo` overwrites any local file whose git-blob sha differs from
// upstream's, and deletes any local row whose path is gone upstream. Both are
// right for a mirror catching up. But "local sha differs from remote" describes
// TWO situations at once:
//
//   * upstream moved on and the mirror is behind  -> must overwrite
//   * the operator edited the file and has not pushed -> must NOT overwrite
//
// The same ambiguity makes an absent-upstream path either "upstream deleted it"
// or "I just created it". No diff can separate them; only provenance can. That
// is `project_files.synced_sha`: the upstream blob sha each row was last known
// to correspond to.
//
// Pure by design — no database, no network, no environment — so the rule that
// decides whether someone's work survives can be tested with no install, which
// is the same reason lib/selfDevRunRules.js and lib/selfDevDrift.js's evaluator
// are pure. scripts/verify-sync-safety.mjs exercises it.
import { gitBlobSha } from './selfDevRepo.js';

/**
 * @typedef {{ path: string, content: string }} LocalFile
 * @typedef {{ path: string, sha: string }} RemoteBlob
 */

/**
 * What would be lost by syncing?
 *
 * @param {object} input
 * @param {LocalFile[]} input.local            current workspace rows
 * @param {RemoteBlob[]} input.remote          upstream tree (excluded paths already filtered)
 * @param {Map<string,string|null>} [input.syncedShaByPath]  provenance per path
 * @returns {{modified: string[], orphaned: string[], atRisk: number}}
 */
export function assessLocalLoss({ local = [], remote = [], syncedShaByPath } = {}) {
  const provenance = syncedShaByPath instanceof Map ? syncedShaByPath : new Map();
  const remoteShaByPath = new Map(remote.map((r) => [r.path, r.sha]));
  const modified = [];
  const orphaned = [];

  for (const file of local) {
    const localSha = gitBlobSha(file.content ?? '');
    const remoteSha = remoteShaByPath.get(file.path);
    const synced = provenance.get(file.path) ?? null;

    if (remoteSha === undefined) {
      // No longer upstream. Either upstream deleted it (safe to drop) or it was
      // created here and has never been pushed (must not be lost).
      //
      // Provenance decides, EXCEPT that unknown provenance is treated as
      // "protect": a file with no recorded provenance cannot be shown to have
      // come from upstream, and the demonstrated loss was exactly this case — a
      // card the chat had just created, which upstream had never seen.
      const knownUpstreamCopy = synced !== null && localSha === synced;
      if (!knownUpstreamCopy) orphaned.push(file.path);
      continue;
    }

    if (remoteSha === localSha) continue;          // already current
    // Untouched since its last sync: upstream moved on, and overwriting is the
    // whole point of syncing.
    if (synced !== null && localSha === synced) continue;

    // Either it was edited here, or provenance is unknown.
    //
    // Unknown provenance is NOT treated as local work here, and the asymmetry
    // with the orphan case above is deliberate: every row that predates this
    // column has none, so treating it as "edited" would make the first sync on
    // any existing deployment refuse every drifted file — blocking the catch-up
    // it exists to perform. Overwriting an unknown file is the normal path;
    // DELETING an unknown file is the one that cannot be undone.
    if (synced !== null) modified.push(file.path);
  }

  return { modified, orphaned, atRisk: modified.length + orphaned.length };
}

/**
 * Should the sync refuse rather than proceed?
 *
 * Split out so the decision is a testable rule rather than a condition buried in
 * a handler — and so the guard can prove that an explicit acknowledgement is the
 * ONLY way past it, the same shape as the drift guard's acknowledgeDrift.
 */
export function shouldRefuseSync({ assessment, acceptLocalLoss = false } = {}) {
  if (acceptLocalLoss) return false;
  return Boolean(assessment && assessment.atRisk > 0);
}

/**
 * The message a refused sync returns: what is at risk, and the two ways forward.
 *
 * Names the files. A refusal that lists nothing is a refusal the operator has to
 * guess their way past, and the whole failure being fixed here is that the
 * guidance said "re-apply your change" without saying what that would cost.
 */
export function syncRefusalMessage(assessment) {
  const parts = [];
  if (assessment?.modified?.length) {
    parts.push(`${assessment.modified.length} file(s) edited here and not pushed: ${assessment.modified.slice(0, 8).join(', ')}${assessment.modified.length > 8 ? ', …' : ''}`);
  }
  if (assessment?.orphaned?.length) {
    parts.push(`${assessment.orphaned.length} file(s) that exist here but not upstream: ${assessment.orphaned.slice(0, 8).join(', ')}${assessment.orphaned.length > 8 ? ', …' : ''}`);
  }
  return `Sync stopped — it would overwrite or delete un-pushed work. ${parts.join('. ')}. `
    + 'Push the work first, or pass acceptLocalLoss to discard it deliberately.';
}
