// Running model calls AT ONCE: bounded, order-preserving, and deterministic when one fails.
//
// WHY THIS IS ITS OWN MODULE
//
// Two stages now fan out — the coder across independent lanes, and the reviewer across its file chunks — and they
// need DIFFERENT shapes of the same idea. The coder's lanes are already capped by the plan (≤4), so they simply all
// start together. The reviewer's chunks are NOT capped: `REVIEW_CHUNK_SIZE` is 3 files, so a 30-file build is ten
// chunks, and starting ten `deepseek-v4-pro` calls at once is a provider and memory problem rather than a speed
// win. So the reviewer needs a bounded pool, and a pool is the general case — `mapWithConcurrency(items, N, fn)`
// with N ≥ items.length is exactly "all at once".
//
// ⚠️ ORDER IS THE POINT, AND IT IS WHY THIS IS NOT `Promise.all` WITH A SIDE EFFECT. Both callers merge their
// results into something ordered — the coder's `fileOperations` decide what gets applied and what the reviewer
// reads; the reviewer's issues and summaries are read in sequence by the operator. Merging in COMPLETION order
// would make the same plan produce a different build and a differently-ordered report on every run, which is the
// property that makes a parallel pipeline impossible to reason about. Results come back indexed by input position,
// and a failure is reported by the FIRST input that failed rather than whichever call happened to fail fastest.
//
// Run:  node scripts/verify-lane-partition.mjs

export const MAX_CONCURRENT_ENV = 'MORPHEUS_MAX_LANES';
export const DEFAULT_MAX_CONCURRENT = 3;
/** Never more than this many model calls in flight for one stage, whatever a caller asks for. Two ceilings bind:
 *  the provider's tolerance for simultaneous reasoning calls, and this container's memory for N prompts in flight. */
export const MAX_CONCURRENT_CEILING = 4;

function clampLimit(limit) {
  const n = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_MAX_CONCURRENT;
  return Math.max(1, Math.min(MAX_CONCURRENT_CEILING, n));
}

/**
 * The deployment's concurrency for one stage, from the environment so it can be changed between two runs of the
 * same task without a deploy — and so `1` is available as a true sequential baseline. **`1` disables fan-out
 * everywhere**, which is also the switch to reach for if concurrency ever misbehaves in production.
 * Unreadable input falls back to the default: a typo in an env var must not stop a build.
 */
export function maxConcurrentCalls(env = process.env) {
  const raw = env?.[MAX_CONCURRENT_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_CONCURRENT;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENT;
  return clampLimit(n);
}

/**
 * Run `fn(item, index)` for every item, at most `limit` at a time, returning results IN INPUT ORDER.
 *
 * Every item is attempted even if an earlier one fails (the same as `Promise.allSettled`), and then the failure
 * belonging to the LOWEST index is thrown — so which error ends a stage is a property of the plan, not of the
 * network. Items after the first failure are not wasted work: for the reviewer they are chunks that would have
 * been reviewed anyway, and for the coder they are already-generated files that the caller reports.
 *
 * @param {Array} items
 * @param {number} limit — clamped to [1, MAX_CONCURRENT_CEILING]; 1 means strictly sequential.
 * @param {(item: any, index: number) => Promise<any>} fn
 * @returns {Promise<Array>} results, indexed by input position
 */
export async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const cap = clampLimit(limit);

  const results = new Array(list.length);
  const failures = new Map();
  let next = 0;

  // `cap` workers, each pulling the next index when it frees up. Single-threaded, so the read-then-increment is
  // atomic — no lock needed, and it stays a pool rather than a set of fixed batches (a slow call cannot leave the
  // other workers idle while its batch-mates wait).
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      try {
        results[i] = await fn(list[i], i);
      } catch (err) {
        failures.set(i, err);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(cap, list.length) }, worker));
  if (failures.size > 0) throw failures.get(Math.min(...failures.keys()));
  return results;
}
