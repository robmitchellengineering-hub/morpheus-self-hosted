// Admin-only read of how many files in the self-dev workspace differ locally
// from their last synced state, plus a one-line verdict.
//
// This is deliberately READ-ONLY. It does not write anything, and it does not
// alter the existing push-time drift guard (lib/selfDevDrift.js) — that guard
// blocks a push when the workspace is stale; this endpoint merely reports the
// current local count so the operator can see it on the Proving Ground.
//
// WHY THIS FILE IS HAND-WRITTEN RATHER THAN SHIPPED AS GENERATED
//
// Self-dev produced a first version of this endpoint that passed lint, build, all
// guards and the render check, and was broken at runtime: it tried to import
// helpers with guessed names and, when the guesses missed, reimplemented drift
// detection from scratch — a second copy of a rule that already exists in
// lib/selfDevSyncState.js / lib/selfDevSyncSafety.js, which is exactly the
// duplication this repo refuses to accept.
//
// Both are the same failure: it wrote against an imagined API instead of reading
// the one that exists. Here the helpers are loaded dynamically, and any failure
// to load or call them reports unavailability instead of throwing.

export default async function handler({ user }) {
  // The dispatcher's ADMIN_FUNCTIONS gate already covers this; the guard here is
  // so the function is safe if it is ever reached another way.
  if (!user || user.role !== 'admin') return { available: false, reason: 'admin only' };

  let syncState;
  let syncSafety;
  try {
    [syncState, syncSafety] = await Promise.all([
      import('../lib/selfDevSyncState.js'),
      import('../lib/selfDevSyncSafety.js'),
    ]);
  } catch (err) {
    return { available: false, reason: `drift helpers unavailable: ${err?.message || 'unknown error'}` };
  }

  const readProvenance = syncState?.readProvenance;
  const assessLocalLoss = syncSafety?.assessLocalLoss;
  if (typeof readProvenance !== 'function' || typeof assessLocalLoss !== 'function') {
    return {
      available: false,
      reason: 'drift helpers are missing expected exports (readProvenance / assessLocalLoss)',
    };
  }

  try {
    const provenance = await readProvenance();
    const loss = assessLocalLoss(provenance);
    const driftCount = countDrift(loss, provenance);
    return {
      available: true,
      driftCount,
      verdict: driftCount === 0 ? 'In sync — no local drift' : `${driftCount} file(s) differ locally.`,
    };
  } catch (err) {
    return { available: false, reason: `could not compute drift: ${err?.message || 'unknown error'}` };
  }
}

// Count from whichever shape the helpers actually return, without rebuilding
// their logic. The canonical fields are modified / conflicts / orphaned /
// deletions, but a helper may also expose a single total or driftCount.
function countItems(value) {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function countDrift(loss, provenance) {
  const candidates = [loss, provenance].filter((v) => v && typeof v === 'object');
  for (const candidate of candidates) {
    if (typeof candidate.driftCount === 'number') return candidate.driftCount;
    if (typeof candidate.total === 'number') return candidate.total;
  }

  const fields = ['modified', 'conflicts', 'orphaned', 'deletions'];
  let total = 0;
  for (const candidate of candidates) {
    total += fields.reduce((sum, field) => sum + countItems(candidate[field]), 0);
    if (total > 0) return total;
  }
  return 0;
}
