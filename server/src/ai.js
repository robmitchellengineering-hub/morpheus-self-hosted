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
import { shouldUseFallback } from './lib/deepseekBalance.js';

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
        // costUsd (above) is the REAL underlying cost from the model that
        // actually served this call -- kept as-is on the UsageEvent row
        // below for accurate margin/DeepSeek-balance tracking. What the
        // user is actually CHARGED is a separate policy decision
        // (billing.js's resolveBillingRate/resolveBillingMarkup): for any
        // DeepSeek-served call that's always 2x DeepSeek Pro's peak-time
        // rate on these same real token counts, regardless of whether
        // Flash or Pro actually ran it (2026-09-02 pricing decision).
        creditsCharged = await reconcileAgainstActualUsage(userId, model, reservedCredits || 0, inputTokens, outputTokens);
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

// 2026-09-02: "put images and files it can't read through a converter so
// the text AI can understand them" (Rob) — first try the CALLING USER'S OWN
// custom AI connection (Settings → AI Provider). Deliberately reads
// ai_base_url/ai_api_key/ai_model directly off the settings row rather than
// gating on ai_mode === 'custom': the Settings form only *shows* those
// fields while "Custom" is selected, but it never clears them when you
// switch back to "Default (platform)" — so a user who once configured a
// connection there, then flipped back to Default as their driving mode,
// still has it sitting in the row. The connection assists the default
// pipeline, it doesn't replace it.
//
// 2026-09-03 correction: Rob clarified the Gemini connection he meant isn't
// a per-user Settings row at all — it's this deployment's own
// FALLBACK_LLM_* credentials (confirmed via Northflank env: base URL is
// generativelanguage.googleapis.com). Gemini used to be Morpheus's platform
// default before the 2026-09-02 switch to DeepSeek for cost, and that key
// was kept configured as the balance-exhausted fallback — it's just never
// been used for vision. So it's tier 2 here: no per-user connection found?
// use the deployment's already-paid-for Gemini fallback key instead of
// giving up. Every account benefits automatically, not just accounts that
// configure their own connection.
function getVisionAssistConnection(settings) {
  if (settings?.ai_base_url && settings?.ai_api_key && settings?.ai_model) {
    return { baseUrl: settings.ai_base_url, apiKey: decrypt(settings.ai_api_key), rawModel: settings.ai_model, source: 'user-connection' };
  }
  if (process.env.FALLBACK_LLM_BASE_URL && process.env.FALLBACK_LLM_API_KEY) {
    return { baseUrl: process.env.FALLBACK_LLM_BASE_URL, apiKey: process.env.FALLBACK_LLM_API_KEY, rawModel: process.env.FALLBACK_LLM_MODEL, source: 'platform-fallback' };
  }
  return null;
}

// Asks a vision-capable connection to caption/transcribe image(s) into
// plain text. Best-effort: any failure (bad/stale key, connection
// unreachable, that endpoint also rejecting images) just returns null so
// the caller can fall through to the older bare "can't see it" degradation
// note — this must never be the reason a chat turn fails outright.
async function describeImagesWithConnection(connection, imageUrls) {
  try {
    const { baseUrl, apiKey } = connection;
    const model = await resolveModel(connection.rawModel, baseUrl, apiKey);
    const content = [
      {
        type: 'text',
        text:
          'Describe what is shown in each of the following image(s) in thorough detail, ' +
          'including any visible text, transcribed exactly. Another AI that cannot see ' +
          'images will use only your description to respond, so be complete and literal. ' +
          'Number your description per image if there is more than one.',
      },
    ];
    imageUrls.forEach((u) => content.push({ type: 'image_url', image_url: { url: u } }));
    const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0.2 }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const description = data?.choices?.[0]?.message?.content;
    return typeof description === 'string' && description.trim() ? description.trim() : null;
  } catch {
    return null;
  }
}

// Plain-text-ish files (code, config, data, notes) get their actual content
// inlined into the prompt — no AI conversion needed, works for every user
// regardless of what connections they have configured. Binary formats the
// server can't decode as text (pdf, docx, images handled separately, etc.)
// still fall back to being listed as a reference URL only.
const TEXT_FILE_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|sh|bash|yaml|yml|toml|ini|env|xml|html?|css|scss|less|sql|graphql|proto|dockerfile)(\?|$)/i;
const MAX_INLINED_FILE_CHARS = 8000;

async function readTextFileContent(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    let text = await res.text();
    if (text.length > MAX_INLINED_FILE_CHARS) {
      text = text.slice(0, MAX_INLINED_FILE_CHARS) + `\n... [truncated, ${text.length} chars total]`;
    }
    return text;
  } catch {
    return null;
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
    // Step 6b safeguard: when this deployment's primary key is DeepSeek and
    // its prepaid balance has run out, deepseekBalance.js's scheduled check
    // will have already flipped shouldUseFallback() — swap to
    // FALLBACK_LLM_* (if configured) rather than let every call in the app
    // start failing at once. Cheap in-memory read, no extra latency on the
    // hot path. See server/src/lib/deepseekBalance.js.
    const useFallback = shouldUseFallback() && process.env.FALLBACK_LLM_API_KEY;
    const baseUrl = useFallback ? process.env.FALLBACK_LLM_BASE_URL : (process.env.LLM_BASE_URL || 'https://api.openai.com/v1');
    const apiKey = useFallback ? process.env.FALLBACK_LLM_API_KEY : process.env.LLM_API_KEY;
    const rawModel = useFallback ? process.env.FALLBACK_LLM_MODEL : process.env.LLM_MODEL;
    return {
      provider: useFallback ? 'platform-fallback' : 'platform', // tier 2: this deployment's own operator-configured key (or its emergency fallback)
      baseUrl,
      apiKey,
      model: roleModelEnv[role] || roleModelSetting[role] || (await resolvePlatformDefaultModel(role)) || (await resolveModel(rawModel, baseUrl, apiKey)),
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
  // Control Panel decision, and applies to every account ever assigned the
  // role, not just whichever one was promoted first) but still get metered
  // below; a call with no userId at all (shouldn't normally happen) is
  // treated the same as exempt rather than blocking on billing it has no
  // account to bill. 2026-09-02: compare case-/whitespace-insensitively —
  // 'Admin', ' admin', etc. should still exempt rather than silently falling
  // through to billing just because of how the value was typed into the DB.
  let isExempt = true;
  let reservedCredits = 0;
  if (userId) {
    const billingUser = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } }).catch(() => null);
    isExempt = !billingUser || String(billingUser.role || '').trim().toLowerCase() === 'admin';
    if (!isExempt) {
      reservedCredits = await estimatePreCallCredits(prompt, role, model);
      await reserveCredits(userId, reservedCredits); // throws InsufficientCreditsError (402) — hard block, no overdraft grace
    }
  }

  const imageUrls = (fileUrls || []).filter((u) => /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(u));
  const otherUrls = (fileUrls || []).filter((u) => !imageUrls.includes(u));
  const textUrls = otherUrls.filter((u) => TEXT_FILE_EXT.test(u));
  const opaqueUrls = otherUrls.filter((u) => !textUrls.includes(u));

  let effectivePrompt = prompt;
  if (textUrls.length > 0) {
    const readResults = await Promise.all(textUrls.map((u) => readTextFileContent(u)));
    readResults.forEach((text, i) => {
      const url = textUrls[i];
      if (text != null) {
        effectivePrompt += `\n\nCONTENT OF UPLOADED FILE (${url}):\n${text}`;
      } else {
        opaqueUrls.push(url); // couldn't be fetched/read — fall back to just linking it
      }
    });
  }
  if (opaqueUrls.length > 0) {
    effectivePrompt += `\n\nUPLOADED REFERENCE FILES (URLs):\n${opaqueUrls.map((u) => '- ' + u).join('\n')}`;
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
    const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    let res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });

    if (!res.ok) {
      let errText = await res.text().catch(() => '');
      // Some providers/models (this deployment's default among them, at
      // times) don't accept image input at all and reject any request
      // whose messages include an image_url part with a 400. Rather than
      // losing the whole chat turn over an attached image, retry once with
      // the images stripped — the text prompt (schema instruction and all,
      // since it was already appended into the text before this point)
      // still goes through, so the message degrades gracefully instead of
      // hard-failing. 2026-09-02: no static "which models support vision"
      // list to maintain — this reacts to the provider's own rejection.
      const isImageUnsupportedError = imageUrls.length > 0 &&
        /does not support image|image.*not support|unsupported.*image|vision.*not support|multimodal/i.test(errText);
      if (isImageUnsupportedError) {
        const originalText = messages[0].content?.[0]?.text ?? messages[0].content;
        // 2026-09-02/03: before giving up on the image(s) entirely, try a
        // vision-capable connection to turn them into a text description
        // and splice that into the prompt that goes to the default model,
        // instead of just dropping the image(s) silently. Prefers the
        // calling user's own connection; falls back to this deployment's
        // Gemini FALLBACK_LLM_* credentials (see getVisionAssistConnection
        // above) so this works out of the box even for accounts with no
        // custom connection configured.
        const visionConnection = getVisionAssistConnection(settings);
        const imageDescription = visionConnection
          ? await describeImagesWithConnection(visionConnection, imageUrls)
          : null;
        const fallbackText = imageDescription
          ? `${originalText}\n\n[${imageUrls.length} image(s) were attached. The current AI model can't see images directly, so here is a description generated by a connected vision AI:\n${imageDescription}]`
          : `${originalText}\n\n[Note: ${imageUrls.length} image(s) were attached to this message, but the current AI model does not accept image input, so this reply was generated from the text only. A vision-capable model can be set in Settings → AI Provider → Agent Models.]`;
        const fallbackBody = { ...body, messages: [{ role: 'user', content: fallbackText }] };
        res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(fallbackBody) });
        if (!res.ok) {
          errText = await res.text().catch(() => '');
          throw new Error(`AI endpoint error (${res.status}): ${errText.slice(0, 300)}`);
        }
      } else {
        throw new Error(`AI endpoint error (${res.status}): ${errText.slice(0, 300)}`);
      }
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
