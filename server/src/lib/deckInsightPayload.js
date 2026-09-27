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
