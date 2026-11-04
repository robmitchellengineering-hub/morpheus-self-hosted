#!/usr/bin/env node
// verify-corpus-promote.mjs — the rule that decides what a customer's evidence is allowed to become.
//
// The bar this guard enforces, in the order it matters:
//   · ONE install reporting the same recipe forty times is ONE observation, not consensus (count(*) would call it a rule)
//   · k independent installs is the threshold, and one install short is NOT evidence
//   · SURVIVED outranks CAUGHT, because a hazard we do not catch is worth more than a guard we already have
//   · a row with no install id is counted, reported, and can never confirm anything
//   · the same evidence promoted twice produces the same id, so a rejection is not re-litigated
//
// No database and no network: `promoteObservations` is a pure function of rows, which is why this runs in the no-install job.
import { promoteObservations, digest, MIN_INSTALLS } from '../server/src/lib/corpusPromote.js';

let wrong = 0;
const check = (name, ok, detail = '') => { if (!ok) wrong++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`); };

const recipe = (n) => `recipe${String(n).padStart(26, '0')}`;   // 32 hex-ish chars, like the SDK's truncated sha256
const row = (o = {}) => ({
  recipe: recipe(1), verdict: 'caught', trials: 2, check_kind: 'node', repo: 'r1', install_id: 'inst_a',
  observed_at: '2026-11-04T00:00:00Z', ...o,
});

console.log('\nthreshold: independent installs, not rows\n');
{
  // one install, forty rows — the shape a noisy node produces
  const noisy = Array.from({ length: 40 }, () => row({ install_id: 'inst_a' }));
  const p = promoteObservations(noisy);
  check('one install × 40 rows is NOT a candidate', p.candidates.length === 0, `got ${p.candidates.length}`);
  check('…and it is counted as below threshold, not lost', p.stats.belowThreshold === 1, JSON.stringify(p.stats));
}

console.log('\nk independent installs is the bar\n');
{
  const atBar = Array.from({ length: MIN_INSTALLS }, (_, i) => row({ install_id: `inst_${i}` }));
  const p = promoteObservations(atBar);
  check(`${MIN_INSTALLS} installs → one candidate`, p.candidates.length === 1, `got ${p.candidates.length}`);
  check('…carrying the install count', p.candidates[0]?.installs === MIN_INSTALLS, String(p.candidates[0]?.installs));

  const underBar = atBar.slice(0, MIN_INSTALLS - 1);
  const q = promoteObservations(underBar);
  check(`one install short → no candidate`, q.candidates.length === 0, `got ${q.candidates.length}`);
}

console.log('\nanonymous rows are counted, never confirming\n');
{
  const anon = Array.from({ length: 10 }, () => row({ install_id: null }));
  const p = promoteObservations(anon);
  check('ten anonymous rows → no candidate', p.candidates.length === 0, `got ${p.candidates.length}`);
  check('…reported as anonymous', p.stats.anonymousRows === 10, String(p.stats.anonymousRows));
}

console.log('\nsurvived outranks caught\n');
{
  const rows = [
    ...Array.from({ length: MIN_INSTALLS }, (_, i) => row({ recipe: recipe(2), verdict: 'caught', install_id: `c${i}` })),
    ...Array.from({ length: MIN_INSTALLS }, (_, i) => row({ recipe: recipe(3), verdict: 'survived', install_id: `s${i}` })),
  ];
  const p = promoteObservations(rows);
  check('both shapes candidate', p.candidates.length === 2, `got ${p.candidates.length}`);
  check('survived is first', p.candidates[0]?.verdict === 'survived', p.candidates.map((c) => c.verdict).join(','));
  check('survived asks about a hazard', /hazard/.test(p.candidates[0]?.ask ?? ''), p.candidates[0]?.ask ?? '');
  check('caught asks about a reference guard', /reference guard/.test(p.candidates[1]?.ask ?? ''), p.candidates[1]?.ask ?? '');
}

console.log('\nthe same evidence yields the same id\n');
{
  const build = () => Array.from({ length: MIN_INSTALLS }, (_, i) => row({ install_id: `x${i}` }));
  const a = promoteObservations(build()).candidates[0]?.id;
  const b = promoteObservations(build()).candidates[0]?.id;
  check('id is stable across runs', a && a === b, `${a} vs ${b}`);
  check('id is prefixed so it cannot be mistaken for an invariant', /^promo_[0-9a-f]{12}$/.test(a ?? ''), a ?? '');
  const other = promoteObservations([...build()].map((r) => ({ ...r, recipe: recipe(9) }))).candidates[0]?.id;
  check('different recipe → different id', other !== a, `${a} vs ${other}`);
}

console.log('\nthe digest is actionable\n');
{
  const p = promoteObservations(Array.from({ length: MIN_INSTALLS }, (_, i) => row({ verdict: 'survived', install_id: `d${i}` })));
  const d = digest(p);
  check('digest names the threshold', /threshold/.test(d), d.split('\n')[1] ?? '');
  check('digest carries the ask', /hazard the corpus does not catch/.test(d), d.split('\n').slice(-1)[0] ?? '');
}

console.log('\nrejections are explicit\n');
{
  const p = promoteObservations([{ verdict: 'caught' }, { recipe: recipe(1) }, null]);
  check('a row with no recipe is rejected', p.rejected.length >= 1, JSON.stringify(p.rejected.map((r) => r.why)));
  const bad = promoteObservations('not an array');
  check('a non-array is refused', bad.ok === false, String(bad.ok));
}

console.log(wrong === 0 ? '\ncorpus promote: every case behaves\n' : `\ncorpus promote: ${wrong} case(s) wrong\n`);
process.exit(wrong === 0 ? 0 : 1);
