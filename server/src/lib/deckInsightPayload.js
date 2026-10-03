// What a SCHEDULED insight response actually is, and what to do when it is unusable.
//
// WHY THIS EXISTS (2026-09-27)
//
// `invokeAI` returns an ALREADY-PARSED object whenever a schema is passed
// (`ai.js`: `if (schema) return { result: JSON.parse(content) }`). The scheduled
// branch of runJarvisSynthesis did `JSON.parse(result)` anyway, which stringifies
// the object and throws — `SyntaxError: "[object Object]" is not valid JSON` — on
// EVERY successful call. Every scheduled run therefore returned
// `{ skipped: true, reason: 'unparseable' }`, deckInsight counted that as an
// ordinary skip, and its summary line read "0 raised, N skipped": healthy-looking.
// The proactive insight — Jarvis telling you before you notice it yourself — had
// never raised anything, for anyone, since it shipped (`ddfb0a9`). The manual
// button worked the whole time because that path passes no schema, which is
// exactly why nothing caught it.
//
// That is hazard H13's shape: a state that cannot be told apart from a legitimate
// empty result. So the three outcomes are separate here — a usable payload, a
// legitimate "nothing worth raising", and a genuinely unusable one — and the
// caller is loud about the last, because it means a defect rather than a quiet day.
//
// Pure, so `scripts/verify-insight-optout.mjs` can assert all three without a model
// call, which is the only reason a bug this total could have shipped unnoticed.

/** @returns {{ok: false, reason: string} | {ok: true, raise: false} | {ok: true, raise: true, insight: string}} */
export function interpretScheduledResult(result) {
  let payload = result;
  // Tolerate a JSON string too: a caller that passes no schema gets prose, and a
  // provider change that hands back a string must not silently become a defect.
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return { ok: false, reason: 'unparseable' };
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'not-an-object' };
  }
  const insight = String(payload.insight || '').trim();
  if (!payload.worthRaising || !insight) return { ok: true, raise: false };
  return { ok: true, raise: true, insight };
}

// What a synthesis turn STORES, if anything — the single decision between the model's
// response and `deckJarvisMessage.create`.
//
// The manual path used to pass no schema at all, so it rambled until it hit the cap:
// three presses on 2026-10-02 (15:39/15:41/15:42) took 61s, 53s and 59s, every one
// saturated at 6000 output tokens, and NONE stored anything. Bounding the answer by its
// SHAPE instead of by a cap lets it decline (worthRaising false) rather than fill the
// budget. This function makes the storage decision explicit and testable:
//
//   * `truncated` wins over a valid-looking result. A cut-off JSON object can still
//     parse, so "the payload looks fine" is not evidence that the answer finished —
//     H6's OUTPUT_TRUNCATED (and invokeAI's own salvage path) must store NOTHING.
//   * a decline, an empty insight, or an unusable payload stores NOTHING: a blank
//     "Suggestions" card is indistinguishable from Jarvis having nothing to say.
//   * what is stored is the INTERPRETED text, never the raw payload.
//
// @returns {{ok: true, content: string} | {ok: false, reason: string}}
export function synthesisMessageToStore({ result, truncated = false } = {}) {
  if (truncated) return { ok: false, reason: 'truncated' };
  const outcome = interpretScheduledResult(result);
  if (!outcome.ok) return outcome;
  if (!outcome.raise) return { ok: false, reason: 'nothing-to-raise' };
  return { ok: true, content: outcome.insight };
}
