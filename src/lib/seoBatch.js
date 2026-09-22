// Client-side batching for the SEO tab's AI actions.
//
// Why the client slices instead of sending everything in one request: every
// server-side AI call is capped at 180s (server/src/ai.js AI_FETCH_TIMEOUT_MS),
// and a request that returns no bytes for minutes is cut by whatever sits in the
// middle (edge, proxy, mobile network) — the browser reports that as a bare
// "Failed to fetch". Sending up to 25 items in one request made the server run
// five sequential model calls before answering at all, which is exactly that
// failure (measured, 2026-09-22). One request now carries at most
// SEO_REQUEST_ITEMS items, so a request is one model call and answers inside the
// envelope that already worked — and the progress and ETA fall out of the loop
// for free, which is what the operator actually needs to see.
//
// SEO_REQUEST_ITEMS must stay ≤ the server's own per-call chunk
// (server/src/lib/seoPrompts.js SEO_ITEMS_PER_CALL). At or below it, each
// request is exactly one model call; above it, the server silently splits the
// request again and it goes back to being multi-call. scripts/verify-seo.mjs
// asserts the relationship, because it is a contract across a boundary no
// compiler checks.
export const SEO_REQUEST_ITEMS = 5;

// How many items one click of FILL MISSING works on. Bounded on purpose:
//
//   * the server's MAX_BATCH is 25, and
//   * the review list is applied with ONE bulk_set_seo, which the server caps at
//     MAX_BULK_ITEMS = 100 items (wordPressSeoAction.js) by silently slicing the
//     payload — so generating more than can be applied would look like a complete
//     apply while quietly dropping the rest.
//
// Anything left over stays in the FILL MISSING count and is reported in the
// panel's note, so a second click is an informed choice rather than a surprise.
// scripts/verify-seo.mjs asserts this stays within the server's batch cap.
export const SEO_BATCH_MAX = 25;

/**
 * Split items into request-sized slices, preserving order.
 *
 * A partition, not a filter: every item lands in exactly one slice, so a batch
 * cannot be sliced and silently lose items. Returns [] for an empty input, so a
 * caller can render "nothing to do" without a special case.
 */
export function sliceForRequests(items, size = SEO_REQUEST_ITEMS) {
  const list = Array.isArray(items) ? items : [];
  const per = Math.max(1, Math.trunc(size) || SEO_REQUEST_ITEMS);
  const out = [];
  for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per));
  return out;
}

/**
 * Stitch the per-request responses back into the single review batch the panel
 * shows. The response shape is generateSeoMeta's own; the sums are what the
 * header reports ("18 to review · 3 not generated"), so they must add up across
 * requests rather than reflect only the last one.
 */
export function mergeBatchResults(results) {
  const list = (Array.isArray(results) ? results : []).filter(Boolean);
  const byId = new Map();
  let requested = 0;
  let generated = 0;
  let titleOnly = 0;
  const missing = [];
  let ownsHead = null;
  let activePlugin = null;

  for (const r of list) {
    for (const s of Array.isArray(r.suggestions) ? r.suggestions : []) {
      const id = Number(s?.id);
      if (!Number.isInteger(id) || byId.has(id)) continue; // first answer per id wins
      byId.set(id, s);
    }
    requested += Number(r.requested) || 0;
    generated += Number(r.generated) || 0;
    titleOnly += Number(r.title_only) || 0;
    if (Array.isArray(r.missing)) missing.push(...r.missing);
    if (r.owns_head != null) ownsHead = r.owns_head;
    if (r.active_plugin != null) activePlugin = r.active_plugin;
  }

  const suggestions = [...byId.values()];
  return {
    suggestions,
    requested,
    generated: generated || suggestions.length,
    missing,
    title_only: titleOnly,
    owns_head: ownsHead,
    active_plugin: activePlugin,
    requests: list.length,
  };
}

/**
 * Remaining time for a loop that has finished `done` of `total` slices.
 *
 * Measured, not guessed: it extrapolates the slices that already completed.
 * Returns null when there is nothing to extrapolate from yet (the UI then says
 * "estimating…" instead of inventing a number), and 0 once the loop is done.
 */
export function estimateRemainingMs({ done, total, elapsedMs }) {
  const t = Math.trunc(Number(total) || 0);
  const d = Math.trunc(Number(done) || 0);
  if (t <= 0) return null;
  if (d >= t) return 0;
  if (d <= 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return Math.round((elapsedMs / d) * (t - d));
}
