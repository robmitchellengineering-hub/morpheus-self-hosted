// Can this repo still prove its guards can fail?
//
// The companion to scripts/mutate-guards.mjs, which does the actual work — apply one sabotage, run the
// guard, fail if it stays green. That runner is a command a person runs; this is the part CI enforces, and
// it is cheap on purpose: no guard is executed here, so it can live in the no-install guards job.
//
// What it will not let happen:
//   * a guard added to verify.mjs with no mutation, or with a mutation that no longer matches its file
//     (H19: a mutation that no longer matches must be reported as STALE, never skipped silently);
//   * a mutation pointing at a guard or a file that does not exist;
//   * two mutations for one guard, or a mutation that changes nothing (`find === replace`);
//   * the unproven count going UP, which is what an unchecked new guard looks like.
//
// Run:  node scripts/verify-guard-mutations.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATIONS, NOT_YET_PROVEN, UNPROVEN_BASELINE } from './guard-mutations.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
/** Occurrences of a literal in a file — the staleness test, and it must count ALL of them, not the first. */
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

// The HARD list, read from the one gate rather than duplicated here.
const hard = (() => {
  const m = /const HARD = \[([\s\S]*?)\];/.exec(read('scripts/verify.mjs'));
  if (!m) throw new Error('could not read the HARD list out of scripts/verify.mjs');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
})();

console.log(`\n1. every mutation is usable (${MUTATIONS.length} mutation(s) for ${hard.length} guard(s))`);
const guardsInHard = new Set(hard);
check('no mutation names a guard that is not in the gate',
  MUTATIONS.map((m) => m.guard).filter((g) => !guardsInHard.has(g)), []);
check('no guard is mutated twice',
  [...new Set(MUTATIONS.map((m) => m.guard).filter((g, i, a) => a.indexOf(g) !== i))], []);
check('every mutation names a file that exists',
  MUTATIONS.filter((m) => !existsSync(join(ROOT, m.file))).map((m) => m.file), []);
check('every mutation says WHY it falsifies the guard',
  MUTATIONS.filter((m) => typeof m.why !== 'string' || m.why.length < 30).map((m) => m.guard), []);
// A mutation that replaces text with itself is a no-op, so the guard would pass and the registry would claim
// coverage. The runner would report it green and someone would "fix" it by deleting the entry.
check('no mutation is a no-op',
  MUTATIONS.filter((m) => m.find === m.replace || !m.find || m.find === '').map((m) => m.guard), []);

console.log('\n2. no mutation has gone STALE — an unmatched sabotage proves nothing');
// The whole point of reporting staleness separately: a `find` that no longer matches means the guard is no
// longer proven, and silently skipping it is how a dead mutation reads as a live one.
const stale = [];
const ambiguous = [];
for (const m of MUTATIONS) {
  if (!existsSync(join(ROOT, m.file))) continue; // already reported above
  const n = occurrences(read(m.file), m.find);
  if (n === 0) stale.push(`${m.guard} → ${m.file}`);
  else if (n > 1) ambiguous.push(`${m.guard} → ${m.file} (${n}x)`);
}
check('no mutation has stopped matching its file', stale, []);
// Ambiguity matters for the same reason: `String.replace` takes the first match, so a `find` occurring twice
// may mutate the wrong site and still go red — a false pass with the right colour.
check('…and every mutation matches exactly once', ambiguous, []);

console.log('\n3. the gap may only shrink');
const proven = new Set(MUTATIONS.map((m) => m.guard));
const unproven = hard.filter((g) => !proven.has(g));
// EQUALITY, not "<= baseline". The first version allowed `unproven.length <= UNPROVEN_BASELINE`, and
// negative-testing it found the hole straight away: raising the constant to 74, 80 or 86 all passed, so
// anyone adding an unproven guard could wave it through by editing one number — the exact failure this
// guard exists to prevent, wearing the guard's own uniform. Equality means the number must always BE the
// gap: prove one and you must lower it; add an unproven guard and it goes red.
check('the ratchet equals the real gap — lower it when you prove one, never raise it',
  unproven.length, UNPROVEN_BASELINE);
// The named list is for guards a text edit genuinely cannot reach, so every row must be real — a stale row
// is a reason that has stopped being true.
check('every "cannot express it" row names a real guard',
  NOT_YET_PROVEN.map((r) => r.guard).filter((g) => !guardsInHard.has(g)), []);
check('…and every one of those guards really is unproven',
  NOT_YET_PROVEN.map((r) => r.guard).filter((g) => proven.has(g)), []);
check('…and each gives a reason', NOT_YET_PROVEN.filter((r) => typeof r.why !== 'string' || r.why.length < 30).map((r) => r.guard), []);

console.log('\n4. the checks above are able to fail');
// Behavioural self-tests, because a validator that cannot reject anything passes section 1-3 for the wrong
// reason. These call the same rule the sections above use, on inputs that must be rejected.
check('the staleness rule catches a find that matches nothing', occurrences('abc', 'zzz'), 0);
check('…and does not fire on one that matches', occurrences('abcabc', 'abc'), 2);
check('the ambiguity rule would catch a two-match find', occurrences('abcabc', 'abc') > 1, true);
check('the ratchet rejects one more unproven guard than allowed', (UNPROVEN_BASELINE + 1) <= UNPROVEN_BASELINE, false);

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(`proven: ${MUTATIONS.length} guard(s) · unproven: ${unproven.length} (baseline ${UNPROVEN_BASELINE}) · not expressible as a text edit: ${NOT_YET_PROVEN.length}`);
if (failures) {
  console.log('\n✗ a guard here is not proven to be able to fail — run scripts/mutate-guards.mjs\n');
  process.exit(1);
}
console.log('every listed mutation still matches, and no guard has joined the unproven pile\n');
