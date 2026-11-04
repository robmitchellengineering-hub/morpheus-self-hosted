// corpusPromote.js — turning what users' runs observed into something the corpus can hold.
//
// THE GAP THIS CLOSES. `corpusIngest` has been writing rows into `corpus_observations` since 2026-11-02 and NOTHING has ever
// read them. So the corpus grew only from our own machines (`valiant corpus absorb` → `publish-feed`), and a customer's
// evidence pooled in a table where no one could act on it. Measured 2026-11-04: one writer, no reader.
//
// WHAT A ROW ACTUALLY IS. A salted recipe hash, a verdict, a trial count, the SHAPE of the check, a repo fingerprint and a
// hashed licence id — no file, no find, no replace, no check text. That is enough to say "guard shape X, under this kind of
// check, was seen to catch / not catch a sabotage" and NOT enough to reconstruct anybody's source. This module never
// pretends otherwise: it cannot produce a rule from a hash, and it does not try.
//
// WHAT IT PRODUCES. Candidates for a human to accept, each with the evidence that justifies it:
//
//   · SURVIVED, k+ independent installs — a guard that was broken and did NOT go red, seen by several installs. That is the
//     shape of a hazard we do not yet catch: the most valuable thing in the table.
//   · CAUGHT, k+ independent installs — the same guard shape going red reliably. That is a demonstrated rule, worth shipping
//     as a reference guard.
//   · anything under k installs — NOT evidence. One anonymous install is a rumour; the whole point of k is that a single
//     customer's odd repo cannot become a corpus rule.
//
// TWO INDEPENDENT INSTALLS MEANS TWO DIFFERENT `install_id`s, not two rows: one machine reporting the same recipe forty times
// is one observation, and a naive `count(*)` would have made every noisy node look like consensus.
//
// NO DATABASE, NO NETWORK, NO CLOCK OF ITS OWN — so the guard that proves this runs in the no-install CI job.
import { createHash } from 'node:crypto';

/** How many independent installs a shape needs before it is evidence. Three is the smallest number that is not a coincidence. */
export const MIN_INSTALLS = 3;

/** A candidate must also have been seen at least this many times in total, so one flaky run per install is not enough. */
export const MIN_OBSERVATIONS = MIN_INSTALLS;

const isReal = (v) => typeof v === 'string' && v.length >= 8 && v !== 'null' && v !== 'undefined';

/**
 * Group raw observation rows into candidate corpus entries.
 *
 * @param {Array<object>} rows  rows shaped like `corpus_observations` (recipe, verdict, trials, check_kind, repo, install_id, observed_at)
 * @returns {{ok: boolean, candidates: Array, rejected: Array, stats: object}}
 */
export function promoteObservations(rows, { minInstalls = MIN_INSTALLS, minObservations = MIN_OBSERVATIONS, now = new Date() } = {}) {
  if (!Array.isArray(rows)) return { ok: false, candidates: [], rejected: [], stats: {} };

  const groups = new Map();
  const rejected = [];
  for (const r of rows) {
    if (!r || !isReal(String(r.recipe ?? ''))) { rejected.push({ row: r, why: 'no recipe hash' }); continue; }
    if (!r.verdict) { rejected.push({ row: r, why: 'no verdict' }); continue; }
    const key = `${r.recipe}\u0000${r.verdict}`;
    const g = groups.get(key) || {
      recipe: String(r.recipe),
      verdict: String(r.verdict),
      checkKind: r.check_kind ?? null,
      installs: new Set(),
      observations: 0,
      trials: [],
      first: null,
      last: null,
    };
    // A row with no install id cannot count toward independent confirmation — it is anonymous, and anonymous cannot be
    // independent. It is still counted in the total, and the stats say how many rows were un-attributable.
    if (r.install_id) g.installs.add(String(r.install_id));
    g.observations += 1;
    if (Number.isInteger(r.trials)) g.trials.push(r.trials);
    const at = r.observed_at ? new Date(r.observed_at) : null;
    if (at && !Number.isNaN(at.getTime())) {
      if (!g.first || at < g.first) g.first = at;
      if (!g.last || at > g.last) g.last = at;
    }
    groups.set(key, g);
  }

  const candidates = [];
  let belowThreshold = 0;
  for (const g of groups.values()) {
    if (g.installs.size < minInstalls || g.observations < minObservations) { belowThreshold += 1; continue; }
    const meanTrials = g.trials.length ? g.trials.reduce((a, b) => a + b, 0) / g.trials.length : null;
    // STABLE IDS. A candidate's id is derived from what it is about, so promoting the same evidence twice produces the same
    // id and a human who already rejected it does not have to reject it again. `promo_` keeps it distinguishable from a
    // corpus invariant (which is a number) and from a hazard (H-prefixed).
    const id = `promo_${createHash('sha256').update(`${g.recipe}\u0000${g.verdict}`).digest('hex').slice(0, 12)}`;
    candidates.push({
      id,
      kind: g.verdict === 'survived' ? 'candidate-hazard' : g.verdict === 'caught' ? 'candidate-guard' : 'candidate-signal',
      recipe: g.recipe,
      verdict: g.verdict,
      checkKind: g.checkKind,
      installs: g.installs.size,
      observations: g.observations,
      meanTrials: meanTrials === null ? null : Math.round(meanTrials * 10) / 10,
      firstSeen: g.first ? g.first.toISOString() : null,
      lastSeen: g.last ? g.last.toISOString() : null,
      // What a human is being asked to do with it, in a sentence, so the digest is actionable without reading this file.
      ask: g.verdict === 'survived'
        ? 'a guard was broken and did not go red — this shape is a hazard the corpus does not catch yet'
        : 'the same guard shape went red reliably — worth shipping as a reference guard',
    });
  }

  // SURVIVED FIRST. A hazard we do not catch is worth more than a guard we already have, and the list should arrive in that
  // order rather than alphabetically.
  candidates.sort((a, b) => (a.verdict === 'survived' ? -1 : 0) - (b.verdict === 'survived' ? -1 : 0) || b.installs - a.installs);

  const anonymous = rows.filter((r) => r && !r.install_id).length;
  return {
    ok: true,
    candidates,
    rejected,
    stats: {
      rows: rows.length,
      groups: groups.size,
      belowThreshold,
      anonymousRows: anonymous,
      minInstalls,
      minObservations,
      generatedAt: now.toISOString(),
    },
  };
}

/** A one-screen digest, for the function's reply and for a run artefact. */
export function digest(promotion) {
  const { candidates, stats } = promotion;
  const lines = [];
  lines.push(`corpus promote: ${stats.rows} row(s) → ${stats.groups} shape(s) → ${candidates.length} candidate(s)`);
  lines.push(`  threshold: ${stats.minInstalls} independent installs, ${stats.minObservations} observations`);
  if (stats.anonymousRows) lines.push(`  ${stats.anonymousRows} row(s) had no install id and cannot count toward confirmation`);
  if (stats.belowThreshold) lines.push(`  ${stats.belowThreshold} shape(s) below the threshold — not evidence yet, not lost`);
  for (const c of candidates.slice(0, 20)) {
    lines.push(`  ${c.id}  ${c.kind.padEnd(16)} installs=${String(c.installs).padStart(2)} obs=${String(c.observations).padStart(3)} check=${c.checkKind ?? '?'}`);
    lines.push(`      ${c.ask}`);
  }
  if (candidates.length > 20) lines.push(`  … ${candidates.length - 20} more`);
  return lines.join('\n');
}
