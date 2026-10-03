// The one decision that sits between Jarvis's reply and each transport, as a pure function.
//
// WHY THIS EXISTS (2026-10-04). `chatWithJarvis` now streams its reply — one NDJSON `delta` event per
// fragment of the `{ reply: string }` the model is writing — so two things that used to be obvious
// became choices that can be wrong:
//
//   1. OPT IN. Streaming is negotiated with a `stream: true` field in the body, deliberately NOT the
//      Accept header, copying generateSeoMeta.js: `functions.invoke` and `functions.invokeStream` send
//      byte-identical requests today, so a header could not tell them apart — and a caller that sends no
//      `stream` field (an older deployed bundle, curl, a script) must keep getting exactly today's plain
//      JSON `{ reply }` and status codes. This predicate is the off switch, so it is asserted directly
//      rather than being a condition buried in a 200-line handler.
//
//   2. FALL BACK. A stream is a longer conversation with the network than a single POST: more chances to
//      fail, and it fails later, after bytes have already reached the operator. Any outcome that is not a
//      COMPLETE, non-empty reply — a failed fetch, an HTTP error, a body that ended without a terminal
//      chunk, an envelope that never parsed, an empty answer — hands the turn to the existing blocking
//      `invokeAI` call. A broken stream must never mean a broken chat.
//
//      Note what "truncated" means here, because PR #489 settled the neighbouring question in the
//      opposite direction and these must not be confused:
//
//        * a TRUNCATED STREAM — the body stopped mid-answer, so what is in hand is a FRAGMENT — is never
//          stored. It falls back, and the blocking call produces the whole reply. That is H6's refusal
//          applied to the transport: a half-answer must never be written down as the answer.
//        * a CEILING-CUT REPLY — the model finished but hit `max_tokens` — is a different thing, and
//          #489 decided it is kept: the blocking reply call retries as plain prose and stores the text it
//          managed to write, because "a verbose answer beats a lost one". The streaming path inherits
//          exactly that, by falling back into the same call, and it stores NOTHING of its own partial
//          fragment. The length fix and the streaming fix therefore do not trade against each other;
//          they meet in `blockingReply`.
//
// Pure and import-free so `scripts/verify-jarvis-stream.mjs` can assert both decisions with no model,
// no key and no database, which is the only way a decision this consequential gets tested at all.

/** Stage ids/labels, kept here so the handler and the guard share one spelling. */
export const JARVIS_READING_STAGE = 'reading';
export const JARVIS_READING_LABEL = 'Reading the question';
export const JARVIS_REPLY_STAGE = 'reply';
export const JARVIS_REPLY_LABEL = 'Writing the reply';
// The bounded shortening pass (#489). It cannot be shown happening — it rewrites text the operator has
// already read — so it is announced as a stage instead, and its result replaces the streamed bubble when
// the terminal event lands.
export const JARVIS_TRIM_STAGE = 'trim';
export const JARVIS_TRIM_LABEL = 'Tightening the reply';
// Looking a fact up (2026-10-04). Rob: *"I would like him to exhast all efforts and reseach if
// necessary first to get a resolution before off loading to a professional."* Research is the one
// part of that which happens BEFORE the reply and takes real seconds, so it is announced rather than
// hidden — otherwise the operator sees a longer pause and no reason for it.
export const JARVIS_RESEARCH_STAGE = 'research';
export const JARVIS_RESEARCH_LABEL = 'Checking the current facts';

/**
 * Is this request asking for the streamed reply? Only an explicit boolean `true` turns it on — a string
 * `"true"`, a 1, a missing field, a null: all off. The asymmetry is deliberate and matches
 * generateSeoMeta.js: the cost of wrongly streaming is paid by every existing caller, the cost of not
 * streaming is one caller that asked badly.
 */
export function wantsStreamedReply(body) {
  return body?.stream === true;
}

/**
 * What to do with a streaming attempt's outcome.
 *
 * @param {{ok?: boolean, complete?: boolean, text?: unknown}} result `ok:false` = the attempt threw;
 *   `complete:false` = the body ended without a terminal chunk (a truncated stream — the fragment is NOT
 *   the answer); `text` = the reply text the stream produced, if any.
 * @returns {{action: 'store', content: string} | {action: 'fallback', reason: string}}
 */
export function streamReplyDecision({ ok = false, complete = false, text = '' } = {}) {
  if (!ok) return { action: 'fallback', reason: 'stream-failed' };
  if (!complete) return { action: 'fallback', reason: 'stream-truncated' };
  const content = String(text ?? '');
  // An empty answer is not stored either — but it is not refused HERE, because the blocking call makes
  // that refusal today and it must stay the one place it is made (see chatWithJarvis.js: "Jarvis returned
  // an empty reply — nothing was stored"). Falling back reaches it, and if the blocking call does answer,
  // the operator gets a reply instead of an error.
  if (!content.trim()) return { action: 'fallback', reason: 'stream-empty' };
  return { action: 'store', content };
}
