// Owner/Admin Control Panel (Feature Backlog #8) — generic admin-editable
// key/value store. Read from ai.js's resolveEndpoint() on every AI call, so
// this is deliberately cached in memory: a DB round-trip on every single
// chat/build step would add real latency to the thing the user is waiting
// on, which is exactly the mistake avoided elsewhere (see ai.js's
// recordUsageEvent — fire-and-forget for the same reason). A 30s cache
// means an admin's model-routing change takes up to 30s to reach in-flight
// traffic, which is fine — the backlog's own "Needs deciding later" note on
// this feature suggests a managed swap with warning/countdown for anything
// more disruptive than that anyway; this is not meant to be instantaneous.
import { prisma } from '../db.js';

const CACHE_TTL_MS = 30 * 1000;
let cache = null;
let cachedAt = 0;

async function loadAll() {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  try {
    const rows = await prisma.platformSetting.findMany();
    cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    cachedAt = Date.now();
  } catch {
    // Table may not exist yet on an unmigrated DB, or the read failed for
    // some other reason — keep the last known-good cache (even if stale)
    // rather than let a settings lookup break an AI call. On first-ever
    // failure (cache still null) this resolves to "no overrides", which is
    // exactly today's behavior before this feature existed.
    cache = cache || {};
  }
  return cache;
}

// Never throws — every call site treats a missing/failed lookup as "no
// override configured", falling through to whatever the existing
// env-var/auto-discovery behavior already was.
export async function getPlatformSetting(key) {
  try {
    const all = await loadAll();
    return all[key] || null;
  } catch {
    return null;
  }
}

export async function getAllPlatformSettings() {
  return loadAll();
}

export async function setPlatformSetting(key, value, adminId) {
  await prisma.platformSetting.upsert({
    where: { key },
    update: { value, updated_by_id: adminId },
    create: { key, value, updated_by_id: adminId },
  });
  cache = null; // bust so the new value is visible immediately, not after the TTL
}
