// AI gateway: resolves the endpoint/model for each call, invokes
// OpenAI-compatible chat completions, and meters real token usage.
//
// Model resolution order (first match wins):
//   1. Per-user overrides (UserSettings.ai_* / role-specific settings)
//   2. Environment variables (LLM_* below)
//   3. Admin-editable PlatformSettings (default_<role>_model keys)
//   4. Hard-coded fallbacks (DEFAULT_MODELS) — never used in production for
//      platform calls, only as a final safety net for unconfigured envs.
import { prisma } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { getModelRate, computeCostUsd } from './lib/modelPricing.js';
import { getPlatformSetting } from './lib/platformSettings.js';

// Hard-coded fallbacks — updated 2026-09-13 to the new DeepSeek identifiers.
// The old names (deepseek-v4-flash, deepseek-v4-pro) are gone from every layer.
const DEFAULT_MODELS = {
  default: 'DeepSeek-V4.1-Flash',
  planner: 'DeepSeek-V4.1-Flash',
  coder: 'DeepSeek-V4.1-Flash',
  reviewer: 'DeepSeek-V4.1-Flash',
  diagnosis: 'DeepSeek-V4.1-Flash',
};

const ROLE_ENV_MAP = {
  default: 'LLM_MODEL',
  planner: 'LLM_PLANNER_MODEL',
  coder: 'LLM_CODER_MODEL',
  reviewer: 'LLM_REVIEWER_MODEL',
  diagnosis: 'LLM_DIAGNOSIS_MODEL',
};

function getEnvDefault(role) {
  const envVar = ROLE_ENV_MAP[role];
  return process.env[envVar] || null;
}

async function getPlatformDefault(role) {
  if (role === 'default') return null;
  return getPlatformSetting(`default_${role}_model`);
}

export async function getUserSettings(userId) {
  return prisma.userSettings.findUnique({ where: { created_by_id: userId } });
}

async function getUserOverride(userId, role) {
  const settings = await getUserSettings(userId);
  if (!settings) return null;
  const roleField = {
    default: settings.ai_model,
    planner: settings.planner_model,
    coder: settings.coder_model,
    reviewer: settings.reviewer_model,
    diagnosis: settings.diagnosis_model,
  }[role];
  return roleField || null;
}

// Resolve the model identifier actually used for a given user + role.
// Returns { model, baseUrl, apiKey } — baseUrl/apiKey resolved in the same
// tiered order as the model, but with separate env fallbacks for the platform
// key and base URL.
export async function resolveEndpoint(userId, role = 'default') {
  const model =
    (await getUserOverride(userId, role)) ||
    getEnvDefault(role) ||
    (await getPlatformDefault(role)) ||
    DEFAULT_MODELS[role] ||
    DEFAULT_MODELS.default;

  const settings = await getUserSettings(userId);
  const userBaseUrl = settings?.ai_base_url;
  const userApiKey = settings?.ai_api_key;
  const hasUserEndpoint = userBaseUrl && userApiKey;

  if (hasUserEndpoint) {
    return {
      model,
      baseUrl: userBaseUrl,
      apiKey: decrypt(userApiKey),
    };
  }

  // Platform-wide defaults (LLM_* env vars, falling back to the hosted broker).
  const envBaseUrl = process.env.LLM_BASE_URL || process.env.MORPHEUS_AI_GATEWAY_URL || process.env.MORPHEUS_BROKER_URL;
  const envApiKey = process.env.LLM_API_KEY || process.env.MORPHEUS_AI_GATEWAY_TOKEN;

  return {
    model,
    baseUrl: envBaseUrl || 'https://api.deepseek.com',
    apiKey: envApiKey || '',
  };
}

// Core invocation — every AI call in Morpheus goes through here.
export async function invokeAI({ userId, role = 'default', messages, temperature = 0.7, maxTokens = 4096, responseFormat = null }) {
  const { model, baseUrl, apiKey } = await resolveEndpoint(userId, role);
  if (!apiKey) {
    throw new Error('No AI provider configured for this request');
  }

  const payload = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (responseFormat === 'json_object') payload.response_format = { type: 'json_object' };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AI provider error (${response.status}): ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const inputTokens = data.usage?.prompt_tokens || 0;
  const outputTokens = data.usage?.completion_tokens || 0;
  const costUsd = computeCostUsd(model, inputTokens, outputTokens);

  try {
    await prisma.usageEvent.create({
      data: {
        created_by_id: userId,
        role,
        provider: apiKey === process.env.LLM_API_KEY ? 'platform' : 'custom',
        model_id: model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
      },
    });
  } catch (err) {
    console.error('Failed to log usage event:', err);
  }

  return {
    content: data.choices?.[0]?.message?.content || '',
    model,
    inputTokens,
    outputTokens,
    costUsd,
  };
}
