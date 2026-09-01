// Ported from base44/shared/aiUtils.ts.
//
// Base44's original had two paths: the platform's own InvokeLLM gateway
// (billed via Base44 credits), or the operator's custom OpenAI-compatible
// endpoint. Self-hosted, there is no platform gateway — every call goes to
// an OpenAI-compatible endpoint. What's preserved is the *shape*: a
// server-wide default (env vars, this deployment's "house" key) that any
// user can override per-role in their own UserSettings — same UX, same
// role-override semantics (planner/coder/reviewer/diagnosis), same
// truncation handling — just one fewer branch.
import { prisma } from './db.js';
import { decrypt } from './crypto.js';
import { aiGatewayDefault } from './config/hostedDefaults.js';
import { discoverLatestModel } from './freshness.js';
import { getModelRate, computeCostUsd } from './lib/modelPricing.js';
import { getPlatformSetting } from './lib/platformSettings.js';
import { estimatePreCallCredits, reserveCredits, reconcileCredits, reconcileAgainstActualUsage } from './lib/billing.js';

export async function getUserSettings(userId) {
  if (!userId) return null;
  try {
    return await prisma.userSettings.findUnique({ where: { created_by_id: userId } });
  } catch {
    return null;
  }
}

// Leaving LLM_MODEL (or a per-role override, or a user's custom ai_model in
// Settings) blank, "auto", or "latest" means "no opinion — keep this on the
// newest model automatically". resolveModel below is what actually does
// that: same discovery logic freshness.js uses for the admin freshness
// report, reused here so there's exactly one place that knows how to find
// "the newest model" per provider — for Gemini that's Google's own
// `gemini-flash-latest` alias (they hot-swap it server-side, 2-week email
// notice first — zero-maintenance); for any other OpenAI-compatible
// endpoint it's the newest chat model from that endpoint's own `/models`
// list. A pinned, literal model id always wins and is passed through
// untouched — this only ever fires when nobody asked for a specific model.
async function resolveModel(raw, baseUrl, apiKey) {
  const v = String(raw || '').trim().toLowerCase();
  if (v && v !== 'auto' && v !== 'latest') return raw;
  const { model } = await discoverLatestModel(baseUrl, apiKey);
  return model || 'gpt-4o-mini';
}

// Owner/Admin Control Panel (Feature Backlog #8) — "change the default AI
// model(s) Morpheus uses platform-wide ... without a code deploy." Checks
// the admin-editable PlatformSetting store (role-specific key first, then
// the platform-wide base key), falling back to null (= no override, exactly
// today's behavior) if nothing's been set. Slotted into resolveEndpoint()
// below AFTER the existing env-var/per-user-setting checks, so it only ever
// fills in for users who were already going to get the "Automatic" /
// auto-discovery behavior — it never overrides an operator's explicit
// LLM_*_MODEL env pin or a user's own per-role Settings choice.
async function resolvePlatformDefaultModel(role) {
  return (
    (role && (await getPlatformSetting(`default_${role}_model`))) ||
    (await getPlatformSetting('default_model')) ||
    null
  );
}

// Token System Build Plan Step 2 — real per-call metering. Logs one
// UsageEvent row per completed AI call with the provider's own real token
// counts (not the old bucketed *estimates* in lib/costEstimate.js, which
// remain in place unchanged for the existing Cost Tracker page). Called
// from the single choke point every invokeAI() caller already goes
// through, so metering exists everywhere for free instead of needing each
// of the ~13 call sites to remember to log it themselves.
//
// Deliberately fire-and-forget (not awaited by invokeAI) and always
// swallows its own errors: metering must never add latency to, or break,
// the actual AI response the user is waiting on. credits_charged stays 0 —
// Step 3 (pre-call reserve/reconcile enforcement) is what will eventually
// set it; this step only makes usage data honest.
// Step 3 addition: also reconciles the pre-call credit reservation (see
// invokeAI's reserveCredits call below) against the real cost computed here,
// and records the actual credits charged on the UsageEvent row. `isExempt`
// accounts (admins) skip the reconcile/charge entirely but still get a
// UsageEvent logged with credits_charged: 0 -- exempt means "don't charge,"
// not "don't meter" (TOKEN-SYSTEM-BUILD-PLAN.md Step 3).
async function recordUsageEvent({ userId, role, provider, model, usage, isExempt, reservedCredits }) {
  if (!userId || !usage) return; // no usage object = provider didn't report token counts
  try {
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
    const rate = await getModelRate(model);
    const costUsd = computeCostUsd(inputTokens, outputTokens, rate);

    let creditsCharged = 0;
    if (!isExempt) {
      try {
        creditsCharged = await reconcileAgainstActualUsage(userId, model, reservedCredits || 0, costUsd);
      } catch {
        // Reconciliation failing must never break metering itself -- the
        // reservation already happened; worst case here is a stale balance
        // that a later call's reservation will still enforce correctly.
      }
    }

    await prisma.usageEvent.create({
      data: {
        created_by_id: userId,
        role: role || null,
        provider,
        model_id: model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        credits_charged: creditsCharged,
      },
    });
  } catch {
    // Table may not exist yet on an unmigrated DB, or the write failed for
    // some other reason — never let metering break the AI call itself.
  }
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
      provider: 'custom', // tier 1: the account's own key, set in Settings → AI Provider
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
      model: roleModelEnv[role] || roleModelSetting[role] || (await resolvePlatformDefaultModel(role)) || (await resolveModel(process.env.LLM_MODEL, baseUrl, apiKey)),
    };
  }

  // Tier 3: no account key, no operator key — fall back to the Morpheus
  // Cloud default gateway (see config/hostedDefaults.js), if configured.
  const hosted = aiGatewayDefault();
  if (hosted?.apiKey) {
    return {
      provider: 'morpheus-cloud',
      baseUrl: hosted.baseUrl,
      apiKey: hosted.apiKey,
      model: roleModelEnv[role] || roleModelSetting[role] || (await resolvePlatformDefaultModel(role)) || (await resolveModel(process.env.LLM_MODEL, hosted.baseUrl, hosted.apiKey)),
    };
  }

  // Tier 4: nothing configured at all — no apiKey to discover a model with,
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
 * @param {object} [opts.schema] JSON schema — when set, forces a structured JSON response
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
      'or have the user set a custom endpoint in Settings → AI Provider.'
    );
  }

  // Step 3 — pre-call billing enforcement (lib/billing.js). Admin accounts
  // are billing-exempt (role column, not a hardcoded email — the Admin
  // Control Panel decision) but still get metered below; a call with no
  // userId at all (shouldn't normally happen) is treated the same as exempt
  // rather than blocking on billing it has no account to bill.
  let isExempt = true;
  let reservedCredits = 0;
  if (userId) {
    const billingUser = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } }).catch(() => null);
    isExempt = !billingUser || billingUser.role === 'admin';
    if (!isExempt) {
      reservedCredits = await estimatePreCallCredits(prompt, role, model);
      await reserveCredits(userId, reservedCredits); // throws InsufficientCreditsError (402) — hard block, no overdraft grace
    }
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

  const body = { model, messages, temperature: 0.7 }; // no max_tokens cap — "max think power" default

  if (schema) {
    body.response_format = { type: 'json_object' };
    const jsonInstruction = `\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra prose) matching this exact schema:\n${JSON.stringify(schema)}`;
    if (imageUrls.length > 0) messages[0].content[0].text += jsonInstruction;
    else messages[0].content += jsonInstruction;
  }

  // Everything from here through capturing `usage` is wrapped so a failure
  // before the provider actually did billable work (network error, non-2xx
  // response, no content returned) refunds the pre-call reservation in
  // full — a failed call the user got no value from must never keep their
  // credits. Once `usage` is known, real work happened and was really
  // billed by the provider, so recordUsageEvent's normal reconcile (which
  // can still be a partial refund or a small extra charge) takes over —
  // see the OUTPUT_TRUNCATED checks below, which intentionally bill for
  // real consumed tokens even though the response was cut off.
  let data;
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`AI endpoint error (${res.status}): ${errText.slice(0, 300)}`);
    }

    data = await res.json();
    if (data?.choices?.[0]?.message?.content == null) throw new Error('AI endpoint returned no content');
  } catch (err) {
    if (!isExempt && reservedCredits > 0) {
      await reconcileCredits(userId, reservedCredits, 0).catch(() => {}); // full refund — call never happened
    }
    throw err;
  }

  const usage = data?.usage;
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason;

  // When `model` was an alias (e.g. Gemini's self-updating "gemini-flash-latest"),
  // the response's own `model` field reports which concrete model actually
  // served the request — surface that instead of the alias so logs/UI show
  // real version info even as it changes underneath.
  const resolvedModel = data?.model || model;

  // Fire-and-forget: metering happens regardless of what follows (truncation
  // error, JSON-parse failure) since the provider already billed this call.
  recordUsageEvent({ userId, role, provider, model: resolvedModel, usage, isExempt, reservedCredits }).catch(() => {});

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
