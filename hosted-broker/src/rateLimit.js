// Minimal per-token sliding-window limiter for the AI gateway passthrough —
// protects the broker operator's upstream key from a single misbehaving
// deployment. Good enough for a single broker instance; move to a
// Redis-backed limiter (e.g. rate-limit-redis) if you scale the broker
// itself past one replica, same as SCALING.md recommends for the main app.
const hits = new Map();

export function allow(key, { max = 60, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of hits) {
    const kept = arr.filter((t) => now - t < 5 * 60_000);
    if (kept.length === 0) hits.delete(key);
    else hits.set(key, kept);
  }
}, 5 * 60_000).unref();
