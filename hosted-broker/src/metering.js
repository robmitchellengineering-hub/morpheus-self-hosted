// Server-to-server metering against the instance's own Morpheus backend.
//
// WHY. The `/v1/chat/completions` passthrough used to be gated by one thing: a comma-separated list
// of bearer tokens in this broker's env (BROKER_AI_ALLOWED_TOKENS). Everyone holding one spent the
// broker operator's upstream key, with no account, no balance and no cap — which is why the README
// says to "swap in real per-tenant metering/billing before relying on it at any real scale". This is
// that swap.
//
// HOW THE TWO SERVICES SPLIT. This broker holds the upstream key and the account holds the balance;
// neither one alone can decide. So the instance's backend is the authority and this module asks it,
// in this order, for every metered call:
//
//   verify  →  the instance debits the estimate and returns a signed reservation ticket
//   proxy   →  this broker calls the upstream with its own key
//   usage   →  the instance true-ups against the real token counts and writes the usage row
//   refund  →  only when the call never reached the model, so the reservation is handed back
//
// The instance's answer is authoritative and this broker holds no state: a call it cannot verify is
// refused rather than served. When BROKER_METERING_SECRET is unset, metering is OFF and the old shared
// token list remains the gate — so an existing deployment keeps working until it is configured, and
// nothing here silently becomes the only path.
//
// STREAMING IS REFUSED WHEN METERING IS ON. Token counts arrive in the final chunk of a stream, and a
// proxy that has already handed the caller an SSE connection cannot un-serve it. Serving it anyway
// would be the one unmetered path through a paid gateway, so it is refused explicitly.
const instanceUrl = () => (process.env.BROKER_METERING_INSTANCE_URL || '').replace(/\/+$/, '');
const instanceSecret = () => process.env.BROKER_METERING_SECRET || '';

/** Is per-account metering configured? Unset means "old shared-token behaviour", never "allow all". */
export function meteringEnabled() {
  return Boolean(instanceUrl() && instanceSecret());
}

/**
 * How long to wait on the instance. The verify call sits in the user's critical path before any
 * tokens are generated, so it is bounded tightly: a slow authority must fail the call, not hang it.
 */
const VERIFY_TIMEOUT_MS = Number(process.env.BROKER_METERING_TIMEOUT_MS) || 5000;
const REPORT_TIMEOUT_MS = 8000;

async function askInstance(path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${instanceUrl()}/api/broker/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-morpheus-broker-secret': instanceSecret() },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    return { ok: res.ok, status: res.status, payload };
  } catch (err) {
    return { ok: false, status: 0, payload: null, transportError: err.name === 'AbortError' ? `the instance did not answer within ${timeoutMs}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Rough input size, for the instance's pre-call reservation only — never for the final charge. */
export function promptCharsOf(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) if (typeof part?.text === 'string') chars += part.text.length;
    }
  }
  return chars;
}

/** Refuse streaming when metering is on, before anything is reserved or spent. */
export function streamingRefusal(body) {
  if (meteringEnabled() && body?.stream === true) {
    return 'this gateway meters every call, and a streamed reply cannot be metered — set stream:false, or configure your own LLM_API_KEY for streaming';
  }
  return null;
}

/**
 * Reserve the account's credits for this call. Returns `{ ok, ticket, model, maxOutputTokens }` or
 * `{ ok: false, status, error }` where status is the HTTP status to return to the caller —
 * 402 for a balance that cannot cover the call, 502 when the instance is unreachable, and so on.
 */
export async function verifyCall({ token, body }) {
  const result = await askInstance('verify', {
    token,
    model: body?.model,
    // The name the instance reads, and the one it echoes back as the cap it reserved against. This
    // was `maxTokens` here while the instance read `maxOutputTokens`, so every reservation silently
    // used the instance's ceiling instead of the caller's own cap — the class of bug the
    // cross-service contract check in scripts/verify-cloud-metering.mjs exists to catch.
    maxOutputTokens: body?.max_tokens,
    promptChars: promptCharsOf(body?.messages),
  }, VERIFY_TIMEOUT_MS);

  if (result.transportError) {
    return { ok: false, status: 502, error: `cannot reach the Morpheus instance that bills this account: ${result.transportError}` };
  }
  if (!result.ok) {
    return {
      ok: false,
      status: result.status === 402 ? 402 : result.status,
      error: result.payload?.reason || 'this deployment refused the call',
      reason: result.payload?.reason || null,
      remainingCredits: result.payload?.remainingCredits,
    };
  }
  return { ok: true, ticket: result.payload?.ticket, model: result.payload?.model || body?.model, maxOutputTokens: result.payload?.maxOutputTokens, exempt: result.payload?.exempt === true, remainingCredits: result.payload?.remainingCredits };
}

/** What the call actually used, reported after the upstream answered. Fire-and-forget by the caller. */
export async function reportUsage({ ticket, model, usage, durationMs }) {
  const counts = usageFromResponse({ usage: { prompt_tokens: usage?.prompt_tokens, completion_tokens: usage?.completion_tokens } });
  if (!counts) return { ok: false, transportError: 'the upstream reported no token counts, so this call could not be metered' };
  return askInstance('usage', { ticket, model, inputTokens: counts.inputTokens, outputTokens: counts.outputTokens, durationMs }, REPORT_TIMEOUT_MS);
}

/** Hand a reservation back because the call never reached the model. */
export async function refundCall({ ticket, reason }) {
  return askInstance('refund', { ticket, reason }, REPORT_TIMEOUT_MS);
}

/**
 * Token counts from an OpenAI-compatible response. Null when the upstream did not report them — an
 * unmetered call is not a free one, so the caller must treat null as "this call cannot be billed".
 */
export function usageFromResponse(body) {
  const input = body?.usage?.prompt_tokens;
  const output = body?.usage?.completion_tokens;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { inputTokens: input, outputTokens: output };
}
