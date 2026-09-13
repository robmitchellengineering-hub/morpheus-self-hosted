// Model pricing lookup + real cost computation.
//
// The static MODEL_PRICING table lives in costEstimate.js (this file's
// fallback). Admin-editable prices from ModelCatalogEntry override it.
// Both layers must use the SAME model identifiers — for DeepSeek the
// canonical names are now `DeepSeek-V4.1-Flash` and `DeepSeek-V4-Pro-0813`.
import { prisma } from '../db.js';
import { MODEL_PRICING, DEFAULT_PRICING } from './costEstimate.js';

// Fetch the effective input/output price per 1M tokens for a model.
// Order: ModelCatalogEntry (admin override) → MODEL_PRICING → DEFAULT_PRICING.
export async function getModelRate(model) {
  if (!model) return DEFAULT_PRICING;

  // Admin-editable catalog lookup (by exact model id).
  try {
    const entry = await prisma.modelCatalogEntry.findUnique({
      where: { model_id: model },
      select: { input_price_per_m: true, output_price_per_m: true, active: true },
    });
    if (entry && entry.active && entry.input_price_per_m != null && entry.output_price_per_m != null) {
      return {
        input: entry.input_price_per_m,
        output: entry.output_price_per_m,
      };
    }
  } catch (err) {
    console.error('modelPricing: catalog lookup failed, falling back to static table:', err);
  }

  return MODEL_PRICING[model] || DEFAULT_PRICING;
}

// Compute underlying provider cost (USD) for a single call.
// `markupMultiplier` is not applied here — that's a retail-layer concern
// handled by billing.js when converting cost_usd to credits.
export async function computeCostUsd(model, inputTokens, outputTokens) {
  const rate = await getModelRate(model);
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
