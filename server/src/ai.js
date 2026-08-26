// Ported from base44/shared/aiUtils.ts.
//
// Base44's original had two paths: the platform's own InvokeLLM gateway
// (billed via Base44 credits), or the operator's custom OpenAI-compatible
// endpoint. Self-hosted, there is no platform gateway â every call goes to
// an OpenAI-compatible endpoint. What's preserved is the *shape*: a
// server-wide default (env vars, this deployment's "house" key) that any
// user can override per-role in their own UserSettings â same UX, same
// role-override semantics (planner/coder/reviewer/diagnosis), same
// truncation handling â just one fewer branch.
import { prisma } from './db.js';
import { decrypt } from './crypto.js';
import { aiGatewayDefault } from './config/hostedDefaults.js';
import { discoverLatestModel } from './freshness.js';

const AI_REQUEST_TIMEOUT_MS = 4 * 60 * 1000; // bounds a provider call that would otherwise hang indefinitely

export async function getUserSettings(userId) {
  if (!userId) return null;
  try {
    return await prisma.userSettings.findUnique({ where: { created_by_id: userId } });
  } catch {
    return null;
  }
}

// Leaving LLM_MODEL (or a per-role override, or a user's custom ai_model in
// Settings) blank, "auto", or "latest" means "no opinion â keep this on the
// newest model automatically". resolveModel below is what actually does
// that: same discovery logic freshness.js uses for the admin freshness
// report, reused here so there's exactly one place that knows how to find
// "the newest model" per provider â for Gemini that's Google's own
// `gemini-flash-latest` alias (they hot-swap it server-side, 2-week email
// notice first â zero-maintenance); for any other OpenAI-compatible
// endpoint it's the newest chat model from that endpoint's own `/models`
// list. A pinned, literal model id always wins and is passed through
// untouched â this only ever fires when nobody asked for a specific model.
async function resolveModel(raw, baseUrl, apiKey) {
  const v = String(raw || '').trim().toLowerCase();
  if (v && v !== 'auto' && v !== 'latest') return raw;
  const { model } = await discoverLatestModel(baseUrl, apiKey);
  return model || 'gpt-4o-mini';
}

async function resolveEndpoint(settings, role) {
  const roleModelEnv = {
    planner: process.env.LLM_PLANNER_MODEL,
    coder: process.env.LLM_CODER_MODEL,
    reviewer: process.env.LLM_REVIEWER_MODEL,
    diagnosis: process.env.LLM_DIAGNOSIS_MODEL,
  };
  const roleModelSetting = {
    planner: settings?.planner_model,
    coder: settings?.coder_model,
    reviewer: settings?.reviewer_model,
    diagnosis: settings?.diagnosis_model,
  };

  const useCustom = settings?.ai_mode === 'custom' && settings?.ai_base_url && settings?.ai_api_key && settings?.ai_model;

  if (useCustom) {
    const baseUrl = settings.ai_base_url;
    const apiKey = decrypt(settings.ai_api_key);
    return {
      provider: 'custom', // tier 1: the account's own key, set in Settings â AI Provider
      baseUrl,
      apiKey,
      model: roleModelSetting[role] || (await resolveModel(settings.ai_model, baseUrl, apiKey)),
    };
  }

  if (process.env.LLM_API_KEY) {
    const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
    const apiKey = process.env.LLM_API_KEY;
    return {
      provider: 'platform', // tier 2: this deployment's own operator-configured key
      baseUrl,
      apiKey,
      model: roleModelEnv[role] || roleModelSetting[role] || (await resolveModel(process.env.LLM_MODEL, baseUrl, apiKey)),
    };
  }

  // Tier 3: no account key, no operator key â fall back to the Morpheus
  // Cloud default gateway (see config/hostedDefaults.js), if configured.
  const hosted = aiGatewayDefault();
  if (hosted?.apiKey) {
    return {
      provider: 'morpheus-cloud',
      baseUrl: hosted.baseUrl,
      apiKey: hosted.apiKey,
      model: roleModelEnv[role] || roleModelSetting[role] || (await resolveModel(process.env.LLM_MODEL, hosted.baseUrl, hosted.apiKey)),
    };
  }

  // Tier 4: nothing configured at all â no apiKey to discover a model with,
  // invokeAI() throws before this model value would ever be used.
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  return {
    provider: 'unconfigured',
    baseUrl,
    apiKey: null,
    model: roleModelEnv[role] || roleModelSetting[role] || process.env.LLM_MODEL || 'gpt-4o-mini',
  };
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.prompt
 * @param {object} [opts.schema] JSON schema â when set, forces a structured JSON response
 * @param {string[]} [opts.fileUrls] reference file URLs (images sent as vision content parts)
 * @param {'planner'|'coder'|'reviewer'|'diagnosis'} [opts.role]
 * @returns {Promise<{result: any, provider: string, model: string, usage?: object}>}
 */
export async function invokeAI({ userId, prompt, schema, fileUrls, role }) {
  const settings = await getUserSettings(userId);
  const { provider, baseUrl, apiKey, model } = await resolveEndpoint(settings, role);

  if (!apiKey) {
    throw new Error(
      'No AI endpoint configured. Set LLM_API_KEY (+ LLM_BASE_URL/LLM_MODEL) in the server .env for a house default, ' +
      'set MORPHEUS_BROKER_URL/MORPHEUS_AI_GATEWAY_TOKEN to use the Morpheus Cloud default gateway, ' +
      'or have the user set a custom endpoint in Settings â AI Provider.'
    );
  }

  const imageUrls = (fileUrls || []).filter((u) => /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(u));
  const otherUrls = (fileUrls || []).filter((u) => !imageUrls.includes(u));

  let effectivePrompt = prompt;
  if (otherUrls.length > 0) {
    effectivePrompt += `\n\nUPLOADED REFERENCE FILES (URLs):\n${otherUrls.map((u) => '- ' + u).join('\n')}`;
  }

  let messages;
  if (imageUrls.length > 0) {
    const content = [{ type: 'text', text: effectivePrompt }];
    imageUrls.forEach((u) => content.push({ type: 'image_url', image_url: { url: u } }));
    messages = [{ role: 'user', content }];
  } else {
    messages = [{ role: 'user', content: effectivePrompt }];
  }

  const body = { model, messages, temperature: 0.7 }; // no max_tokens cap â "max think power" default

  if (schema) {
    body.response_format = { type: 'json_object' };
    const jsonInstruction = `\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra prose) matching this exact schema:\n${JSON.stringify(schema)}`;
    if (imageUrls.length > 0) messages[0].content[0].text += jsonInstruction;
    else messages[0].content += jsonInstruction;
  }

    if (/generativelanguage\.googleapis\.com/.test(baseUrl)) {
    // Gemini's "thinking" models default to an unbounded reasoning budget; capping it
    // keeps a request from hanging for minutes before headers even arrive.
    body.reasoning_effort = 'low';
  }

  let res;
  try {
    res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT') {
      throw new Error(`AI endpoint timed out after ${AI_REQUEST_TIMEOUT_MS / 1000}s waiting for a response. Try a shorter prompt or a faster model.`);
    }
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AI endpoint error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const usage = data?.usage;
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason;
  if (content == null) throw new Error('AI endpoint returned no content');

  // When `model` was an alias (e.g. Gemini's self-updating "gemini-flash-latest"),
  // the response's own `model` field reports which concrete model actually
  // served the request â surface that instead of the alias so logs/UI show
  // real version info even as it changes underneath.
  const resolvedModel = data?.model || model;

  if (finishReason === 'length') {
    throw new Error('OUTPUT_TRUNCATED: The AI response was cut off by the token limit before it could finish. Reduce the number of files per step (2-3 max) and retry.');
  }

  if (schema) {
    try {
      return { result: JSON.parse(content), provider, model: resolvedModel, usage };
    } catch {
      const trimmed = content.trimEnd();
      if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
        throw new Error('OUTPUT_TRUNCATED: The AI response was cut off mid-JSON before it could finish. Reduce the number of files per step (2-3 max) and retry.');
      }
      throw new Error('AI endpoint did not return valid JSON');
    }
  }
  return { result: content, provider, model: resolvedModel, usage };
}
