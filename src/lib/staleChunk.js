// A deploy must not look like a crash.
//
// Rob, 2026-09-28, after a day of frequent deploys: "Im also getting this alot in the first stages of
// morpheus — Something broke on this screen. Failed to fetch dynamically imported module:
// https://morpheus.nz/assets/Workspace-Dp8wM2AG.js".
//
// Every route is a `lazy()` import and Vite names each chunk with a content hash, so a page left
// open across a deploy holds a file list the CDN no longer serves: the hash it asks for was
// replaced. Nothing is broken — the page is one reload behind — but the ErrorBoundary cannot tell
// that from a real render bug, so it offered a Reload button and no explanation.
//
// The classification and the once-only decision live here, as pure functions over an injected
// storage object, so they can be tested without a browser (scripts/verify-stale-chunk.mjs). main.jsx
// and RootErrorBoundary.jsx are the two callers, and they share this file rather than each deciding
// for themselves what a chunk error looks like.
export const STALE_CHUNK_KEY = 'morpheus_stale_chunk_reload_at';

// Long enough that the reload has definitely happened (and the app has mounted) before another one
// is allowed; short enough that a deploy later in the same session still gets its own recovery.
export const RELOAD_COOLDOWN_MS = 10_000;

// The three wordings seen in the wild: Vite/Chrome's "Failed to fetch dynamically imported module",
// Safari's "Importing a module script failed", and Firefox's "error loading dynamically imported
// module". Matching all three is why this is a function and not an equality test at a call site.
export function isStaleChunkError(error) {
  const message = String(error?.message || error || '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message);
}

// True when nothing has been reloaded for this recently — a genuine bug, or a device that is
// offline, must not become an endless reload loop.
export function shouldReloadForStaleChunk(now, storage) {
  const last = Number(safeGet(storage)) || 0;
  if (!last) return true;
  return now - last >= RELOAD_COOLDOWN_MS;
}

export function markStaleChunkReload(now, storage) {
  try { storage?.setItem?.(STALE_CHUNK_KEY, String(now)); } catch { /* private mode: no marker, and one reload still happens */ }
}

// Called once the app has actually come up, so the NEXT deploy can trigger another recovery.
export function clearStaleChunkMark(storage) {
  try { storage?.removeItem?.(STALE_CHUNK_KEY); } catch { /* nothing to clear */ }
}

function safeGet(storage) {
  try { return storage?.getItem?.(STALE_CHUNK_KEY); } catch { return null; }
}

// One place that decides and performs the recovery, so the listener in main.jsx and the
// ErrorBoundary cannot disagree about whether a reload is allowed. Returns whether it reloaded.
export function recoverFromStaleChunk({ storage, reload, now = Date.now() } = {}) {
  if (!shouldReloadForStaleChunk(now, storage)) return false;
  markStaleChunkReload(now, storage);
  reload?.();
  return true;
}
