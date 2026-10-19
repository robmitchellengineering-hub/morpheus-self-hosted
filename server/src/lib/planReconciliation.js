// Did the build write what the plan asked for?
//
// WHY THIS EXISTS (defect 9, measured 2026-09-30 on the first real end-to-end backend run). The run
// reported `incomplete: true` with four "missing" files. Three were genuine — the coder built an inline
// frontend and never wrote `public/app.js`, `public/style.css` or `uploads/.gitkeep`. The fourth was not:
// the plan asked for `migrations/001_initial.sql` and the generator wrote `migrations/0001_init.sql`, so a
// file that EXISTS was reported absent. **A false "missing" is worse than none** — it teaches the operator
// to ignore the flag, which is the exact failure this whole area keeps producing.
//
// The old check was `planned.filter(p => !written.has(p))` — a literal set difference. That is correct only
// when the model names files the way the plan did, and it demonstrably does not.
//
// WHAT THIS DOES NOT DO: guess. A reconciliation that is too eager hides real gaps, which is the same bug
// with the opposite sign. So a substitution is claimed ONLY when it is unambiguous in BOTH directions —
// exactly one planned file in that directory is unmatched, and exactly one written file there could be it.
// Two candidates means no claim, and the file stays "missing", because an honest false negative is
// recoverable and a false "all present" is not.
//
// Pure and import-free so scripts/verify-plan-reconciliation.mjs can test every branch without an install.

import { normalizeBackendPath } from './incrementalPersist.js';

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const baseOf = (p) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);
const extOf = (p) => {
  const b = baseOf(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
};

/**
 * Reconcile the plan's file list against what actually reached disk.
 *
 * @returns {{ satisfied: {planned, actual, how}[], substituted: {planned, actual, how}[], missing: string[] }}
 *   `how` is 'exact' (same path), 'moved' (same filename, different directory) or 'renamed' (same directory
 *   and extension, different name — the `001_initial.sql` → `0001_init.sql` case).
 */
export function reconcilePlannedFiles(planned, written) {
  const want = [...new Set((planned || []).map(normalizeBackendPath).filter(Boolean))];
  const have = [...new Set((written || []).map(normalizeBackendPath).filter(Boolean))];
  const unclaimed = new Set(have);

  const satisfied = [];
  const substituted = [];
  const unmatched = [];

  // Pass 1 — the exact path. Anything satisfied here is settled and cannot be claimed again below.
  for (const p of want) {
    if (unclaimed.has(p)) { unclaimed.delete(p); satisfied.push({ planned: p, actual: p, how: 'exact' }); }
    else unmatched.push(p);
  }

  // Pass 2 — MOVED: the same filename somewhere else. Unambiguous by construction, because a filename
  // appearing twice in a written set was already collapsed by the Set above.
  const stillUnmatched = [];
  for (const p of unmatched) {
    const match = [...unclaimed].find((w) => baseOf(w) === baseOf(p));
    if (match) { unclaimed.delete(match); substituted.push({ planned: p, actual: match, how: 'moved' }); }
    else stillUnmatched.push(p);
  }

  // Pass 3 — RENAMED: same directory, same extension, and unique on BOTH sides. This is the migration case
  // and it is the whole reason the module exists.
  const missing = [];
  for (const p of stillUnmatched) {
    const dir = dirOf(p), ext = extOf(p);
    const siblings = stillUnmatched.filter((q) => dirOf(q) === dir && extOf(q) === ext).length;
    // An extensionless file (`Makefile`, `Dockerfile`) gets no rename pass: with no extension to anchor on,
    // "one unmatched file in this directory" is not evidence that these two are the same thing.
    const candidates = ext ? [...unclaimed].filter((w) => dirOf(w) === dir && extOf(w) === ext) : [];
    if (ext && siblings === 1 && candidates.length === 1) {
      unclaimed.delete(candidates[0]);
      substituted.push({ planned: p, actual: candidates[0], how: 'renamed' });
    } else {
      missing.push(p);
    }
  }

  return { satisfied, substituted, missing };
}

/**
 * The sentence the operator is owed, or null when there is nothing worth saying.
 *
 * Only renames and gaps are reported. A build that wrote exactly what the plan asked for needs no sentence,
 * and printing one anyway is how a log becomes noise nobody reads.
 */
export function reconciliationNote({ satisfied = [], substituted = [], missing = [] } = {}) {
  const parts = [];
  if (missing.length) {
    parts.push(`${missing.length} file(s) the plan asked for were not written: ${missing.join(', ')}`);
  }
  for (const s of substituted) {
    parts.push(s.how === 'moved'
      ? `${s.planned} was written as ${s.actual}`
      : `the plan's ${s.planned} was written as ${s.actual}`);
  }
  if (!parts.length) return null;
  const written = satisfied.length + substituted.length;
  return `${written} of ${written + missing.length} planned file(s) written. ${parts.join('; ')}.`;
}
