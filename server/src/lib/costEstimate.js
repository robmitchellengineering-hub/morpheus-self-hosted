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
};

// Fallback for custom-endpoint models we don't recognize (e.g. local Ollama,
// open-source models on Groq/Together). Local models = $0 API cost.
export const DEFAULT_PRICING = { input: 1.00, output: 5.00 };
export const LOCAL_MODEL_PATTERNS = [
  'ollama', 'lm-studio', 'lmstudio', 'local', 'llama', 'mistral',
  'qwen', 'deepseek', 'phi', 'gemma', 'codellama', 'starcoder',
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
