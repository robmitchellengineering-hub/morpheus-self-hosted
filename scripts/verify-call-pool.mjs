// Running model calls at once: bounded, in a known order, and failing deterministically.
//
// WHY THIS IS ITS OWN GUARD
//
// `mapWithConcurrency` is what makes the reviewer's chunks parallel and the coder's lanes parallel, and the claims
// it has to hold are the ones a parallel pipeline lives or dies by — none of which `Promise.all` gives you:
//
//   * **ordered** results, by input position, so the same plan cannot produce a differently-ordered build or report
//     depending on which call returned first;
//   * **bounded** — never more than `limit` calls in flight, because the reviewer's chunk count is not capped by
//     anything (3 files per chunk) and ten simultaneous `deepseek-v4-pro` calls is a provider and memory problem,
//     not a speed win;
//   * **deterministic failure** — the FIRST input that failed, not whichever failed fastest;
//   * and it must actually OVERLAP, which is the only claim here that a text assertion cannot make.
//
// The pool is pure (no imports at all), so this runs in the no-install guards job.
//
// Run:  node scripts/verify-call-pool.mjs
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const { mapWithConcurrency, maxConcurrentCalls, MAX_CONCURRENT_ENV, DEFAULT_MAX_CONCURRENT, MAX_CONCURRENT_CEILING } =
  await import('../server/src/lib/callPool.js');
const { maxLanesFromEnv, MAX_LANES_ENV, MAX_LANES_CEILING } = await import('../server/src/lib/lanePartition.js');

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LANE_MS = 150;

console.log('\nModel calls at once are bounded, ordered, and fail deterministically\n');

// ── 1. ORDER, not completion order ──────────────────────────────────────────────────────────────────────────
// The first item is made the SLOWEST, so a merge by completion would reverse the result. This is the property
// that stops the same plan producing a different build (and a differently-ordered review) on every run.
const completion = [];
const ordered = await mapWithConcurrency([1, 2, 3], 3, async (n) => {
  await sleep(n === 1 ? 90 : 5);
  completion.push(n);
  return `r${n}`;
});
check('results come back in INPUT order', ordered, ['r1', 'r2', 'r3']);
check('…even though completion order was different', completion, [2, 3, 1]);
check('…and the index is handed to the worker', await mapWithConcurrency(['a', 'b'], 2, async (_x, i) => i), [0, 1]);

// ── 2. BOUNDED ──────────────────────────────────────────────────────────────────────────────────────────────
let inFlight = 0;
let maxInFlight = 0;
const track = async () => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await sleep(15);
  inFlight--;
  return 1;
};
await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, track);
check('never more than `limit` calls are in flight', maxInFlight, 2);
maxInFlight = 0;
await mapWithConcurrency([1, 2, 3], 1, track);
check('limit 1 is strictly sequential', maxInFlight, 1);

// ⚠️ AND IT REALLY OVERLAPS. Without this, "the calls run at once" is a comment: the bounded test above passes for
// a pool that runs one at a time, and every ordering test passes for a purely sequential loop.
let t0 = Date.now();
await mapWithConcurrency([1, 2, 3], 3, async () => { await sleep(LANE_MS); return 1; });
const parallelMs = Date.now() - t0;
t0 = Date.now();
await mapWithConcurrency([1, 2, 3], 1, async () => { await sleep(LANE_MS); return 1; });
const sequentialMs = Date.now() - t0;
check('three 150ms calls with limit 3 overlap', parallelMs < 2 * LANE_MS, true);
check('…while limit 1 queues them', sequentialMs >= 3 * LANE_MS, true);

// The pool is a POOL, not fixed batches: with limit 2 over 4 items, a slow first item must not leave its
// batch-mate's slot idle. Batched, the total would be ~2 x the slow call; pooled it is closer to the sum/cap.
t0 = Date.now();
await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => { await sleep(n === 1 ? 120 : 30); return n; });
const pooledMs = Date.now() - t0;
check('a slow item does not idle the other workers (a pool, not batches)', pooledMs < 210, true);

// ── 3. DETERMINISTIC FAILURE ────────────────────────────────────────────────────────────────────────────────
// The FIRST input that failed, not the first to fail. Otherwise the error an operator sees — and the file the
// coder is asked to fix — changes run to run with network timing.
let caught = null;
try {
  await mapWithConcurrency([1, 2, 3], 3, async (n) => {
    if (n === 1) throw new Error('first');
    await sleep(40); // 2 and 3 fail LATER, so "fastest failure" would report one of them
    throw new Error(`later-${n}`);
  });
} catch (err) {
  caught = err;
}
check('the FIRST input to fail is the error reported', caught?.message, 'first');

// Every item is attempted, like `Promise.allSettled` — a later chunk is not skipped because an earlier one failed.
const attempted = [];
try {
  await mapWithConcurrency([1, 2, 3], 3, async (n) => { attempted.push(n); if (n === 1) throw new Error('x'); return n; });
} catch { /* expected */ }
check('every item is still attempted after one fails', attempted.slice().sort(), [1, 2, 3]);

// ── 4. the shapes that must not crash ───────────────────────────────────────────────────────────────────────
check('an empty list is empty', await mapWithConcurrency([], 3, async () => 1), []);
check('a non-array is empty', await mapWithConcurrency(null, 3, async () => 1), []);
check('a limit of 0 still runs everything', (await mapWithConcurrency([1, 2], 0, async (n) => n)).length, 2);
check('…as does a nonsense limit', (await mapWithConcurrency([1, 2], 'x', async (n) => n)).length, 2);
check('a limit above the ceiling is clamped, not honoured', await mapWithConcurrency([1, 2], 99, async (_n, i) => i), [0, 1]);

// ── 5. the environment parameter, defined once ──────────────────────────────────────────────────────────────
check('the default concurrency is 3', maxConcurrentCalls({}), DEFAULT_MAX_CONCURRENT);
check('…and the ceiling is 4', MAX_CONCURRENT_CEILING, 4);
check('the env var is the documented name', MAX_CONCURRENT_ENV, 'MORPHEUS_MAX_LANES');
check('1 means sequential and is honoured', maxConcurrentCalls({ [MAX_CONCURRENT_ENV]: '1' }), 1);
check('a higher ask is clamped to the ceiling', maxConcurrentCalls({ [MAX_CONCURRENT_ENV]: '99' }), MAX_CONCURRENT_CEILING);
check('nonsense falls back to the default', maxConcurrentCalls({ [MAX_CONCURRENT_ENV]: 'lots' }), DEFAULT_MAX_CONCURRENT);
check('a missing env object is not a crash', maxConcurrentCalls(null), DEFAULT_MAX_CONCURRENT);

// ⚠️ ONE DEFINITION, TWO NAMES. The coder's lanes read the limit through lanePartition's alias and the reviewer's
// chunks read it directly. They must be the SAME function and the SAME variable — two readers of one knob is fine,
// two definitions of it is how a setting silently stops applying to half the pipeline.
check('the lane alias is the same function, not a copy', maxLanesFromEnv === maxConcurrentCalls, true);
check('…and the same variable', MAX_LANES_ENV, MAX_CONCURRENT_ENV);
check('…and the same ceiling', MAX_LANES_CEILING, MAX_CONCURRENT_CEILING);

// ── 6. the reviewer actually uses it ────────────────────────────────────────────────────────────────────────
const reviewer = read('server/src/lib/reviewer.js');
check('the reviewer reviews its chunks through the pool', /await mapWithConcurrency\(planned\.willReview, maxConcurrentCalls\(\), async \(chunk\) => \{/.test(reviewer), true);
// ⚠️ AND NOT WITH A LITERAL. A hardcoded limit would make MORPHEUS_MAX_LANES=1 stop being a true baseline for the
// reviewer, and the A/B would compare two concurrent arms while claiming to compare concurrent against sequential.
check('…with the limit from the parameter, not a literal', /mapWithConcurrency\(planned\.willReview, 1,/.test(reviewer), false);
// The old shape was `for (...) { ... await invokeAI(...) }`. A sequential reviewer is the thing being replaced, so
// its return must fail here rather than quietly costing 45s a chunk again.
check('…and the sequential chunk loop is gone', /for \(let i = 0; i < planned\.willReview\.length; i\+\+\)/.test(reviewer), false);
// Order is preserved by accumulating from the pool's ordered results, not by pushing as calls return.
check('…and the per-chunk results are accumulated in order',
  /const perChunk = await mapWithConcurrency/.test(reviewer) && /for \(const r of perChunk\) \{/.test(reviewer), true);

const gate = read('scripts/verify.mjs');
const ci = read('.github/workflows/ci.yml');
check('it is in verify.mjs\'s HARD list', /'verify-call-pool\.mjs'/.test(gate), true);
check('…and CI runs it', /node scripts\/verify-call-pool\.mjs/.test(ci), true);

console.log(`\n${checks - failures}/${checks} checks passed\n`);
if (failures > 0) process.exit(1);
