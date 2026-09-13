// Token System Build Plan Step 2 (see TOKEN-SYSTEM-BUILD-PLAN.md) — real
// per-call cost metering. getModelRate() resolves $/M-token pricing for a
// given model, preferring an admin-edited ModelCatalogEntry row (the table
// Step 1 added; Step 4's admin pricing UI isn't built yet, but the table
// already exists so a future admin edit takes effect immediately with no
// further migration) over the static fallback table in costEstimate.js.
//
// This module only computes *underlying provider cost* for logging
// (UsageEvent.cost_usd) — it does not apply markup or touch credit
// balances. Markup/retail pricing and credit deduction are Step 3/4 work,
// not yet built.
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
