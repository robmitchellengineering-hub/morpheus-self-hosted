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
import { salvageJson } from './lib/salvageJson.js';
import { estimatePreCallCredits, reserveCredits, reconcileCredits, reconcileAgainstActualUsage } from './lib/billing.js';
import { shouldReserveCredits, isFlatRateCall, FLAT_CALL_CREDITS } from './lib/creditPolicy.js';
import { shouldUseFallback } from './lib/deepseekBalance.js';
import { recordCallDuration } from './lib/timingStats.js';
import { jsonrepair } from 'jsonrepair';

// 2026-09-04 (Rob: "the ai agent fix in compile seems to just keep running
// ... getting blocked or faulting in any way"): confirmed via code read that
// the outbound fetch() to the AI provider had NO timeout/AbortController at
// all — a stalled or hung provider (network black hole, an overloaded
// endpoint that accepts the connection but never responds) could leave a
// diagnose/compile/coder call in flight indefinitely, with nothing anywhere
// in the chain (this fetch, base44Client.js's apiFetch on the frontend) ever
// giving up. That reads exactly like "keeps running forever" from the UI's
// perspective — very different from a fast server error like the P2002
// crash fixed the same day in diagnoseIssue.js. This wraps fetch with a hard
// wall-clock cap so a stalled provider surfaces as a clear, catchable
// AI_PROVIDER_TIMEOUT error instead of hanging the request forever. 3
// minutes is generous for even a large maxTokens completion under normal
// provider conditions, while still being far short of "the user gives up
// and assumes it's broken."
const AI_FETCH_TIMEOUT_MS = 180_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = AI_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`AI_PROVIDER_TIMEOUT: The AI provider did not respond within ${Math.round(timeoutMs / 1000)}s. It may be overloaded or unreachable — please retry.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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

// Same admin-editable-override pattern as model routing above, for
// `temperature` — the one build-pipeline knob (planner/coder/reviewer/
// diagnosis, and CONTEXT/BUILD chat) that was previously a single hardcoded
// 0.7 for every role with no way to tune it without a code deploy. Role-
// specific PlatformSetting key first, then the platform-wide base key,
// falling back to the original 0.7 default if nothing's been set — existing
// behavior is unchanged until an admin actually sets one of these.
const DEFAULT_TEMPERATURE = 0.7;
async function resolvePlatformTemperature(role) {
  const raw = (role && (await getPlatformSetting(`default_${role}_temperature`))) ||
    (await getPlatformSetting('default_temperature'));
  if (raw == null || raw === '') return DEFAULT_TEMPERATURE;
  const n = Number(raw);
  // OpenAI-compatible APIs generally accept 0-2; clamp rather than reject so
  // a stray admin typo degrades to a sane bound instead of breaking every
  // call platform-wide.
  return Number.isFinite(n) ? Math.min(2, Math.max(0, n)) : DEFAULT_TEMPERATURE;
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
async function recordUsageEvent({ userId, role, provider, model, usage, isExempt, reservedCredits, task, durationMs, status = 'ok' }) {
  if (!userId || !usage) return; // no usage object = provider didn't report token counts
  try {
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
    const rate = await getModelRate(model);
    const costUsd = computeCostUsd(inputTokens, outputTokens, rate);

    let creditsCharged = 0;
    if (!isExempt && isFlatRateCall({ provider, model })) {
      // A flat charge: the reservation already took exactly this, so there is nothing to reconcile.
      // Skipping the token-based true-up is the whole point — it would re-price a call whose
      // inference we did not pay for (own key) or deliberately do not price per token (a model on
      // FLAT_RATE_MODELS). See creditPolicy.js for both cases.
      creditsCharged = reservedCredits || FLAT_CALL_CREDITS;
    } else if (!isExempt) {
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
        // Observability (2026-09-27). `task` is the call site, `status`/`duration_ms` are what the
        // platform never had: without them a call could not be attributed, timed, or told from a
        // success when it failed. Both paths write — this one for a provider that answered, and
        // `invokeAI`'s provider catch for one that threw — so a failure now leaves a record
        // instead of no trace at all.
        task: task || null,
        status: status === 'error' ? 'error' : 'ok',
        duration_ms: Number.isFinite(durationMs) ? durationMs : null,
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
    // Best-effort helper (caller falls back to a plain "can't see it" note
    // on any failure) — a short 30s timeout so a stalled vision provider
    // can't stall the whole chat turn behind it. See fetchWithTimeout above.
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0.2 }),
    }, 30_000);
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
// regardless of what connections they have configured. PDF/DOCX/XLSX are a
// second tier below (readDocumentFileContent) since they need real parsing,
// not just a fetch-as-text. Anything else still falls back to a reference
// URL only.
const TEXT_FILE_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|sh|bash|yaml|yml|toml|ini|env|xml|html?|css|scss|less|sql|graphql|proto|dockerfile)(\?|$)/i;
const MAX_INLINED_FILE_CHARS = 8000;

async function readTextFileContent(url) {
  try {
    // Best-effort inline (falls back to null → reference-URL-only on any
    // failure); this runs while building the prompt, BEFORE the main
    // provider call even starts, so an unbounded hang here would stall
    // every downstream step just as badly as the provider call itself.
    const res = await fetchWithTimeout(url, {}, 20_000);
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

// 2026-09-17 (Rob: Jarvis needs to accept photos/PDFs/Word/Excel) — a
// second inline tier for real document formats, same "fetch, extract,
// truncate, degrade to a reference URL on any failure" shape as
// readTextFileContent above, just with a format-specific extractor instead
// of a raw text decode. Kept generic here in ai.js (not Deck-specific) so
// every invokeAI caller with fileUrls gets this for free, same as the
// vision-assist path already does for images.
const DOCUMENT_FILE_EXT = /\.(pdf|docx?|xlsx?)(\?|$)/i;

async function readDocumentFileContent(url) {
  try {
    const res = await fetchWithTimeout(url, {}, 20_000);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();

    let text;
    if (ext === 'pdf') {
      const { default: pdfParse } = await import('pdf-parse');
      text = (await pdfParse(buf)).text;
    } else if (ext === 'docx' || ext === 'doc') {
      const mammoth = await import('mammoth');
      text = (await mammoth.extractRawText({ buffer: buf })).value;
    } else if (ext === 'xlsx' || ext === 'xls') {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer' });
      text = wb.SheetNames.map((name) => `SHEET: ${name}\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`).join('\n\n');
    } else {
      return null;
    }

    text = (text || '').trim();
    if (!text) return null;
    if (text.length > MAX_INLINED_FILE_CHARS) {
      text = text.slice(0, MAX_INLINED_FILE_CHARS) + `\n... [truncated, ${text.length} chars total]`;
    }
    return text;
  } catch {
    // Corrupt file, password-protected, unsupported internal format, etc. —
    // degrade to a reference URL rather than fail the whole chat turn.
    return null;
  }
}

async function resolveEndpoint(settings, role, userId) {
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
  //
  // Two ways to authenticate, and the difference is whether the call is billed to the account making
  // it or to nobody in particular:
  //   * a static MORPHEUS_AI_GATEWAY_TOKEN identifies a DEPLOYMENT at the gateway, which is why the
  //     gateway cannot tell whose balance to charge — the unmetered stopgap; and
  //   * no static token, and this deployment can sign — a token is minted for THIS account and the
  //     gateway reserves its credits before the call. That is the paid default, and it is why the
  //     branch below no longer requires `hosted.apiKey` to be present.
  const hosted = aiGatewayDefault();
  if (hosted) {
    let apiKey = hosted.apiKey;
    if (!apiKey && hosted.metered) {
      // Throws rather than falling through to "unconfigured": an unmetered call against a billed
      // gateway is refused by the gateway anyway, and failing here says why.
      apiKey = await hosted.mintForAccount(userId);
    }
    if (apiKey) {
      return {
        provider: 'morpheus-cloud',
        baseUrl: hosted.baseUrl,
        apiKey,
        model: roleModelEnv[role] || roleModelSetting[role] || (await resolvePlatformDefaultModel(role)) || (await resolveModel(process.env.LLM_MODEL, hosted.baseUrl, apiKey)),
      };
    }
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
 * @param {'planner'|'coder'|'reviewer'|'diagnosis'|'seo'} [opts.role]
 * @param {number} [opts.maxTokens] optional output cap. For short, bounded output (a structured
 *   verdict, a single mockup doc) pass a small value — that's the single biggest lever on
 *   wall-clock latency for a non-streamed call, since the request blocks until the model stops
 *   emitting tokens either way.
 *   2026-09-03 correction: DO NOT omit this for large/unbounded output (e.g. the Coder role's full
 *   file contents) expecting "uncapped" to mean unlimited — it doesn't. Leaving max_tokens out of
 *   the request hands control to the PROVIDER's own server-side default, which for this
 *   deployment's endpoint (DeepSeek) is well below what a real multi-file build needs and is not
 *   reliably documented. Every call site must pass an explicit maxTokens; for Coder-role calls use
 *   a large explicit value (64000 as of this deployment's model) rather than leaving it unset.
 *   invokeAI already throws OUTPUT_TRUNCATED on a JSON schema call that gets cut off mid-object,
 *   which callers can surface as a retryable error.
 * @returns {Promise<{result: any, provider: string, model: string, usage?: object}>}
 */
export async function invokeAI({ userId, prompt, schema, fileUrls, role, maxTokens, task, salvagePartial }) {
  // Timed from the first line of the call, so `duration_ms` is what the caller waited — the number
  // the latency questions in every audit so far could only guess at.
  const startedAt = Date.now();
  const settings = await getUserSettings(userId);
  const { provider, baseUrl, apiKey, model } = await resolveEndpoint(settings, role, userId);

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
  // 2026-09-12 (Rob: free usage "withought giving full admin access"): a
  // separate `billing_exempt` flag grants the same exemption without the
  // rest of what `role === 'admin'` unlocks (Admin Panel, ops console,
  // etc.) — see the Admin Panel's "FREE USAGE GRANTS" card.
  let isExempt = true;
  let reservedCredits = 0;
  if (userId) {
    const billingUser = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, billing_exempt: true } }).catch(() => null);
    // The rule lives in lib/creditPolicy.js's shouldReserveCredits, and the RATE in
    // isFlatRateCall()/FLAT_CALL_CREDITS beside it. Note what the reservation rule is NOT shown:
    // the provider resolved above — that is deliberate, and it is why the flat rate is applied
    // here, after the exemption is decided, rather than inside that rule.
    isExempt = !shouldReserveCredits(billingUser);
    if (!isExempt) {
      if (isFlatRateCall({ provider, model })) {
        // The inference is not ours to price — either the operator's own key paid for it, or the
        // model is on FLAT_RATE_MODELS. The charge is FLAT (see creditPolicy.js for the decision and
        // the arithmetic): the reservation IS the charge, and recordUsageEvent does not true it up
        // afterwards.
        reservedCredits = FLAT_CALL_CREDITS;
        await reserveCredits(userId, reservedCredits);
      } else {
        reservedCredits = await estimatePreCallCredits(prompt, role, model, maxTokens);
        await reserveCredits(userId, reservedCredits); // throws InsufficientCreditsError (402) — hard block, no overdraft grace
      }
    }
  }

  const imageUrls = (fileUrls || []).filter((u) => /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(u));
  const otherUrls = (fileUrls || []).filter((u) => !imageUrls.includes(u));
  const textUrls = otherUrls.filter((u) => TEXT_FILE_EXT.test(u));
  const documentUrls = otherUrls.filter((u) => !textUrls.includes(u) && DOCUMENT_FILE_EXT.test(u));
  const opaqueUrls = otherUrls.filter((u) => !textUrls.includes(u) && !documentUrls.includes(u));

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
  if (documentUrls.length > 0) {
    const readResults = await Promise.all(documentUrls.map((u) => readDocumentFileContent(u)));
    readResults.forEach((text, i) => {
      const url = documentUrls[i];
      if (text != null) {
        effectivePrompt += `\n\nEXTRACTED TEXT FROM UPLOADED FILE (${url}):\n${text}`;
      } else {
        opaqueUrls.push(url); // couldn't be parsed (corrupt, password-protected, etc.) — fall back to just linking it
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

  const temperature = await resolvePlatformTemperature(role);
  const body = { model, messages, temperature }; // no max_tokens cap by default — "max think power"
  if (maxTokens) body.max_tokens = maxTokens; // caller opted into a bounded-output call — see invokeAI's JSDoc above

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
  // 2026-09-03 (Rob: stream progress + an ETA in the chat window): timed
  // around just the provider round trip, not the billing/context-assembly
  // work above it, so lib/timingStats.js's per-role rolling average reflects
  // what actually varies call to call — recorded only on success (see below)
  // since a hard network failure's latency isn't representative of a normal
  // call and would skew the ETA down for no good reason.
  const callStartedAt = Date.now();
  try {
    const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    // 2026-09-04: this used to be a bare fetch() with no timeout at all — a
    // stalled provider could hang this call (and everything waiting on it:
    // the diagnose/compile-fix UI, a chat turn, a build step) indefinitely.
    // fetchWithTimeout throws a clear AI_PROVIDER_TIMEOUT after
    // AI_FETCH_TIMEOUT_MS, which the catch block below refunds credits for
    // and rethrows like any other failed call.
    let res = await fetchWithTimeout(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });

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
        res = await fetchWithTimeout(endpoint, { method: 'POST', headers, body: JSON.stringify(fallbackBody) });
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
    // A call that threw used to leave NO trace in usage_events — which is exactly why a failure rate
    // could not be measured, and why every audit had to infer truncations from `output_tokens ==
    // maxTokens`. Record the attempt: no tokens (the provider never reported any), the real duration,
    // and status 'error'. Fire-and-forget, because recording a failure must never replace the error
    // the caller needs to see.
    // `model`, NOT `resolvedModel`. `resolvedModel` is declared BELOW, from the response (`data?.model`),
    // so in this catch it is in its temporal dead zone — referencing it threw
    // "Cannot access 'resolvedModel' before initialization" and THAT replaced the provider's error, which
    // is the precise opposite of what the comment above promises. Found 2026-09-29 by forcing a provider
    // failure in a harness: the caller saw a reference error instead of "AI endpoint error (500)".
    // The request's own model is the honest value here anyway — nothing was served, so nothing renamed it.
    recordUsageEvent({
      userId, role, provider, model, isExempt, reservedCredits: 0,
      usage: { input_tokens: 0, output_tokens: 0 }, task, status: 'error', durationMs: Date.now() - callStartedAt,
    }).catch(() => {});
    throw err;
  }

  // Real wall-clock time for this provider round trip, independent of
  // output size/maxTokens — feeds chatWithMorpheus.js's streamed ETA.
  recordCallDuration(role, Date.now() - callStartedAt);

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
  recordUsageEvent({ userId, role, provider, model: resolvedModel, usage, isExempt, reservedCredits, task, durationMs: Date.now() - startedAt }).catch(() => {});

  // A schema call MUST throw here — half a JSON object is unusable and every
  // caller downstream expects a real parsed value. A plain-text call (no
  // schema — e.g. chatWithJarvis.js's chat reply, suggestDeckReply.js) is
  // different: truncated prose is still a real, readable answer, and
  // discarding it entirely turned "the reply ran a bit long" into "Jarvis
  // never responds" once the energy log went unbounded and long-term memory
  // was added to the prompt (2026-09-17, Rob: "javis is not responding") --
  // both make a long, pattern-spotting reply more likely, which makes hitting
  // MAX_REPLY_TOKENS more likely. Return the truncated text rather than
  // throwing; only schema calls still hard-fail on finishReason === 'length'.
  if (finishReason === 'length' && schema) {
    // 2026-09-03: include which role/maxTokens actually truncated -- three
    // rounds of chasing this same error taught the hard way that "it
    // truncated" alone is nearly useless to debug: the Coder, the Planner,
    // and the Reviewer all throw this identical string, and it took a
    // console log dive to discover it was actually the Planner's cap, not
    // the Coder's, that was failing every build. Now it's in the message
    // itself instead of requiring that every time.
    // The advice has to match the caller. "Reduce the number of files per step" is
    // right for a coder call and nonsense for a bounded one-shot action — it was
    // what runAiAction reported while its mapping endpoint was failing, which
    // sends the reader looking for files that do not exist.
    // 2026-09-28: a caller that asked for salvage gets the largest COMPLETE prefix of the answer
    // instead of a throw, flagged `truncated` so nothing downstream can mistake it for the whole
    // thing. Only a list-shaped caller can use this honestly (see server/src/lib/salvageJson.js);
    // every other schema call, the coder's included, still hard-fails here, because half a file
    // list is not a partial answer, it is a wrong one.
    if (salvagePartial) {
      const salvaged = salvageJson(content);
      if (salvaged) return { result: salvaged.value, provider, model: resolvedModel, usage, truncated: true };
    }
    const hint = role === 'coder'
      ? ' Reduce the number of files per step (2-3 max) and retry.'
      : ' The output budget was consumed before the answer was complete — the role runs on a reasoning model, whose thinking is billed against this same limit.';
    throw new Error(`OUTPUT_TRUNCATED (role=${role || 'unknown'}, maxTokens=${maxTokens ?? 'unset'}): The AI response was cut off by the token limit before it could finish.${hint}`);
  }

  if (schema) {
    try {
      return { result: JSON.parse(content), provider, model: resolvedModel, usage };
    } catch (parseErr) {
      const trimmed = content.trimEnd();
      if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
        // Same opt-in as the finishReason branch above: a caller reading a LIST can use the items
        // that did parse. A failed salvage keeps the original error — never a guessed value.
        if (salvagePartial) {
          const salvaged = salvageJson(content);
          if (salvaged) return { result: salvaged.value, provider, model: resolvedModel, usage, truncated: true };
        }
        throw new Error('OUTPUT_TRUNCATED: The AI response was cut off mid-JSON before it could finish. Reduce the number of files per step (2-3 max) and retry.');
      }
      // 2026-09-03 (Rob: "SYSTEM FAILURE: AI endpoint did not return valid
      // JSON"): the response wasn't cut off (finishReason wasn't 'length'
      // and it ends with a closing brace/bracket) -- it's genuinely
      // malformed JSON. Very common with a code-generation model like this:
      // fileOperations values embed real source (quotes, backticks, raw
      // newlines, backslashes), and the model occasionally emits a literal
      // control character or an unescaped quote inside a string instead of
      // the escaped form, or wraps the object in stray markdown/prose that
      // still happens to end on '}'/']'. Rather than hard-fail a whole
      // build turn over one malformed character, try a best-effort repair
      // (handles unescaped control chars, trailing commas, code fences,
      // leading/trailing prose, single quotes, etc.) before giving up.
      try {
        return { result: JSON.parse(jsonrepair(content)), provider, model: resolvedModel, usage };
      } catch {
        // Repair failed too -- surface enough to actually debug this without
        // a server-log dive (same lesson as the OUTPUT_TRUNCATED message
        // above): which role, the parser's own complaint, and a content
        // snippet so it's visible whether this was stray prose, truncated
        // mid-string, or something else entirely.
        const snippet = content.length > 300 ? content.slice(0, 300) + '…' : content;
        throw new Error(`AI endpoint did not return valid JSON (role=${role || 'unknown'}): ${parseErr.message}. Response started with: ${snippet}`);
      }
    }
  }
  return { result: content, provider, model: resolvedModel, usage };
}
