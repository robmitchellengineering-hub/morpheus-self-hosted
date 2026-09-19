// Token System Build Plan Step 2 (see TOKEN-SYSTEM-BUILD-PLAN.md) — real
// per-call cost metering. getModelRate() resolves $/M-token pricing for a
// given model, preferring an admin-edited ModelCatalogEntry row over the static
// fallback table in costEstimate.js.
//
// Step 4's admin pricing route now exists (admin.routes.js lists and upserts
// ModelCatalogEntry), so an edit takes effect immediately with no migration —
// though the catalog is EMPTY in production today, so in practice every model
// prices from the static table.
//
// This module only computes *underlying provider cost* for logging
// (UsageEvent.cost_usd). Markup, retail pricing and credit deduction live in
// billing.js (Step 3) and ARE built: pre-call reserve, post-call reconcile
// against real usage. An earlier version of this comment claimed Steps 3 and 4
// were "not yet built" long after both shipped — the same doc-drift this
// codebase keeps producing.
//
// KNOWN GAP (2026-09-19): the static table is keyed by model id, and a model
// that isn't in it silently falls back to DEFAULT_PRICING. gemini-3.5-flash-lite
// is in active production use and is NOT in the table, so both its recorded cost
// and its retail charge come from that generic default rather than a rate anyone
// chose for it. scripts/reality.mjs now flags any production model with no
// explicit price, so a new model can't quietly inherit the default again.
import { prisma } from '../db.js';
import { MODEL_PRICING, DEFAULT_PRICING, LOCAL_MODEL_PATTERNS } from './costEstimate.js';

function isLocalModel(modelId) {
  const lower = String(modelId || '').toLowerCase();
  return LOCAL_MODEL_PATTERNS.some((p) => lower.includes(p));
}

// Returns { inputPerM, outputPerM } in $ per 1M tokens. Never throws —
// metering must never break the calling AI request.
export async function getModelRate(modelId) {
  if (isLocalModel(modelId)) return { inputPerM: 0, outputPerM: 0 };

  try {
    const entry = await prisma.modelCatalogEntry.findUnique({ where: { model_id: modelId } });
    if (entry?.active && entry.input_price_per_m != null && entry.output_price_per_m != null) {
      return { inputPerM: entry.input_price_per_m, outputPerM: entry.output_price_per_m };
    }
  } catch {
    // ModelCatalogEntry may not exist yet on an older/unmigrated DB, or the
    // lookup failed for some other reason — fall through to the static
    // table rather than breaking the AI call over a pricing lookup.
  }

  const fallback = MODEL_PRICING[modelId] || DEFAULT_PRICING;
  return { inputPerM: fallback.input, outputPerM: fallback.output };
}

// Underlying provider cost (not retail/marked-up) from real token counts.
export function computeCostUsd(inputTokens, outputTokens, rate) {
  return (
    (Number(inputTokens || 0) * rate.inputPerM + Number(outputTokens || 0) * rate.outputPerM) /
    1_000_000
  );
}
