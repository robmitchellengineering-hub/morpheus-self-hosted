// Ported from base44/shared/costEstimate.ts — verbatim (no Base44 SDK calls
// in the original; only TypeScript type annotations were stripped).
// Estimated USD cost per AI action, based on the model used and typical token
// counts. These are estimates — actual cost depends on prompt size, output
// length, and the provider's exact pricing. For the platform (Base44) path,
// the user pays in credits; the USD estimate shows the underlying compute
// value. For the custom path, the user pays their provider directly at the
// model's listed price.

// USD per 1M tokens (input / output). Approximate public list prices.
export const MODEL_PRICING = {
  automatic: { input: 0.15, output: 0.60 },
  gpt_5_mini: { input: 0.15, output: 0.60 },
  gpt_5_4: { input: 2.50, output: 10.00 },
  gpt_5_6_sol: { input: 5.00, output: 15.00 },
  gpt_5_6_luna: { input: 5.00, output: 15.00 },
  gemini_3_flash: { input: 0.075, output: 0.30 },
  gemini_3_1_pro: { input: 1.25, output: 5.00 },
  claude_sonnet_4_6: { input: 3.00, output: 15.00 },
  claude_opus_4_6: { input: 15.00, output: 75.00 },
  claude_opus_4_7: { input: 15.00, output: 75.00 },
  claude_opus_4_8: { input: 15.00, output: 75.00 },
  'claude-sonnet-5': { input: 3.00, output: 15.00 },
  'kimi-k3': { input: 2.55, output: 12.75 },
  // DeepSeek — the Token System Build Plan's recommended paid-tier default
  // (server/.env.example's LLM_MODEL). Real per-model pricing, not a local
  // model — see the LOCAL_MODEL_PATTERNS note below for why "deepseek" was
  // removed from that list. Admin-overridable via the Admin Panel's Models
  // & Routing tab (ModelCatalogEntry) once real spend data suggests a
  // correction; these are the static fallback used until an admin sets one.
  //
  // Revised 2026-09-02: DeepSeek actually runs a ~2x peak/off-peak price
  // split (roughly 01:00-04:00 and 06:00-10:00 UTC weekdays = peak; the
  // rest of the week, including full weekends, = off-peak at half price).
  // Neither this table nor getModelRate()/computeCostUsd() (modelPricing.js
  // — this is its fallback source when no ModelCatalogEntry override
  // exists) is time-of-day aware, and this table is what actually feeds
  // real billing (server/src/lib/billing.js's reconcileAgainstActualUsage),
  // not just the Admin Panel's display estimate. The previous figures here
  // (flash $0.14/$0.28, pro $0.435/$0.87) were below even DeepSeek's real
  // OFF-peak rate, let alone peak — meaning every DeepSeek call was being
  // metered (and, via the 2x markup, retail-charged) against a cost basis
  // lower than what was actually being paid, worst during peak hours.
  // Fixed by pinning this table to DeepSeek's PEAK rate always (the same
  // "just always charge as if it's peak" approach used for the $8/M retail
  // decision) — a conservative constant that's never an undercharge,
  // whatever the real time-of-day rate turns out to be:
  //   flash: peak $0.44 in / $1.32 out (real off-peak is exactly half)
  //   pro:   peak $1.32 in / $3.96 out (real off-peak is exactly half)
  // Source: DeepSeek's own pricing page, cross-checked against
  // aipricing.guru and codersera.com (2026-09-02).
  //
  // Updated 2026-09-15: DeepSeek retired the "deepseek-v4-flash" model id on
  // 2026-09-10 — it's now a compatibility alias DeepSeek routes to the new
  // V4.1 Flash model ("deepseek-flash"), which is actually what's serving
  // the request and what DeepSeek's own billing reflects, regardless of
  // which id the call used. V4.1 Flash's real peak pricing ($0.30/$1.20) is
  // lower than old V4 Flash's ($0.44/$1.32) — kept both keys (any call still
  // using the legacy id gets the same, now-correct, cost basis as the new
  // id) rather than deleting the old one, since it's still accepted and
  // still shows up in historical UsageEvent rows. "deepseek-v4-pro" is
  // unaffected (DeepSeek confirmed continued support past 2026-09-14) —
  // verified against DeepSeek's current pricing page (2026-09-15).
  'deepseek-v4-flash': { input: 0.30, output: 1.20 },
  'deepseek-flash': { input: 0.30, output: 1.20 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96 },
};

// Fallback for custom-endpoint models we don't recognize (e.g. local Ollama,
// open-source models on Groq/Together). Local models = $0 API cost.
export const DEFAULT_PRICING = { input: 1.00, output: 5.00 };
// Deliberately does NOT include "deepseek": DeepSeek is a real hosted,
// billed API (see MODEL_PRICING above), not a local/free inference
// backend — including it here would make isLocalModel() treat every
// DeepSeek call as $0 cost, silently zeroing out both the real cost_usd
// metering (modelPricing.js) AND the Step 3 pre-call credit charge
// (billing.js) for the platform's own paid default. Caught while wiring
// DeepSeek in as that default (Token System Build Plan Step 6b) — worth
// double-checking before adding any other real hosted provider here too.
export const LOCAL_MODEL_PATTERNS = [
  'ollama', 'lm-studio', 'lmstudio', 'local', 'llama', 'mistral',
  'qwen', 'phi', 'gemma', 'codellama', 'starcoder',
];

// Estimated token usage per action type (input + output). Non-LLM actions
// (GitHub API, ZIP, email) have zero AI token cost.
export const ACTION_TOKENS = {
  chat_build: { input: 4000, output: 3000 },
  chat_simple: { input: 2000, output: 1000 },
  autonomous_step: { input: 12000, output: 8000 },
  test_generation: { input: 4000, output: 3000 },
  github_upload: { input: 0, output: 0 },
  github_import: { input: 0, output: 0 },
  email_export: { input: 0, output: 0 },
  voice_generation: { input: 0, output: 0 },
  zip_export: { input: 0, output: 0 },
  template_publish: { input: 4000, output: 3000 },
  template_install: { input: 2000, output: 1000 },
  compile: { input: 0, output: 0 },
  native_prototype: { input: 4000, output: 3000 },
  diagnosis: { input: 4000, output: 2000 },
};

function isLocalModel(model) {
  const lower = model.toLowerCase();
  return LOCAL_MODEL_PATTERNS.some(p => lower.includes(p));
}

// Returns estimated USD cost for a single usage record, given its action type
// and the toolchain metadata (provider + models used).
export function estimateActionCost(actionType, metadata) {
  const tokens = ACTION_TOKENS[actionType];
  if (!tokens || (tokens.input === 0 && tokens.output === 0)) return 0;

  let provider = 'platform';
  let models = [];

  if (metadata) {
    try {
      const parsed = JSON.parse(metadata);
      provider = parsed.provider || 'platform';
      if (parsed.planner_model) models.push(parsed.planner_model);
      if (parsed.coder_model) models.push(parsed.coder_model);
      if (parsed.reviewer_model) models.push(parsed.reviewer_model);
    } catch {
      // metadata not JSON — ignore
    }
  }

  // If no model info, use 'automatic' for platform, DEFAULT for custom
  if (models.length === 0) {
    models = [provider === 'custom' ? '_custom_default' : 'automatic'];
  }

  // Distribute tokens across the models that were used (planner + coder + reviewer)
  // Each model gets a share of the total token budget
  const tokensPerModel = {
    input: Math.ceil(tokens.input / models.length),
    output: Math.ceil(tokens.output / models.length),
  };

  let cost = 0;
  for (const model of models) {
    let pricing;

    if (model === '_custom_default') {
      // For custom endpoints with no model info, check if it looks local
      pricing = DEFAULT_PRICING;
    } else if (isLocalModel(model)) {
      // Local models (Ollama, LM Studio) have zero API cost
      pricing = { input: 0, output: 0 };
    } else {
      pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
    }

    cost += (tokensPerModel.input * pricing.input + tokensPerModel.output * pricing.output) / 1_000_000;
  }

  return cost;
}
