// The length a CONVERSATIONAL Jarvis reply is measured against, and the one decision that
// bounds it — pure and import-free, so it can be asserted with fixtures and no model.
//
// WHY THIS EXISTS (2026-10-03, measured — Rob's own complaint)
//
// Rob chatted with Jarvis, got an answer, and then wrote: "that was still a bit long how much
// money do you think there is waiting in the emails". The reply to THAT came back **743 output
// tokens — roughly 550 words — in 9.0 s**, against a persona that already told him: "Match your
// reply's length to the question — a quick question gets a quick, cutting answer… keep it short
// enough to speak aloud: usually one to four sentences." The instruction was there and the model
// ignored it, which makes this a SHAPE problem, not a model problem — the same fix the manual
// synthesis needed, where a schema (not a bigger cap) stopped it rambling to its ceiling
// (runJarvisSynthesis.js, 2026-10-03).
//
// IT COMPOUNDS, which is why the size of the STORED reply is the thing worth bounding.
// `lib/promptBounds.js` carries the conversation into the NEXT turn's prompt:
// CONVERSATION_MAX_CHARS = 12000, CONVERSATION_PER_MESSAGE_CHARS = 1500, newest-first with
// omissions named. Measured on his turns: `conversation=4837` characters against `snapshot=0`
// (the new gate working) and `memory=2816` — so the history was already 73% of a greeting's
// prompt, and every long reply is sliced to 1,500 characters in each turn that follows it. A
// shorter stored reply is a smaller conversation block on the next turn: the loop Rob feels.
//
// WHAT IS DELIBERATELY *NOT* HERE
//
// `MAX_REPLY_TOKENS` is NOT lowered. `chatWithJarvis.js`'s own comment records why 6000 is
// generous on this deployment (the model burns a chunk of the budget on hidden reasoning before
// the reply, and `invokeAI` THROWS `OUTPUT_TRUNCATED` when a schema call is cut — H6), and
// MODEL-DECISIONS.md records three separate instances of "fixed a truncating call by moving the
// cap". A smaller cap turns verbosity into a FAILURE. So the reply's SHAPE is bounded instead:
// an explicit role, a `{ reply: string }` schema whose description carries the length rule as
// well as the persona, and — if the reply still overshoots — ONE bounded repair pass whose
// failure keeps the ORIGINAL. A verbose answer beats a lost one, and nothing is ever stored empty.
//
// CONVERSATIONAL TURNS ONLY — THE LONG PATH IS PRESERVED
//
// A user who asks for a report, a plan or a breakdown must still get one. `isLongFormRequest` is
// the explicit line: when the message asks for long-form depth or an artifact, the budget does
// not apply and the reply is never repaired. It is deliberately generous (a false "long form"
// only means a verbose reply is left alone), and the repair itself is lossless-or-nothing, so a
// genuinely long answer can only be shortened when a rewrite can keep every fact — otherwise it
// is kept whole. This is the module-level statement of where the longer path survives.
//
// THE TARGET, AND WHY 600 CHARACTERS
//
//   * the persona's own ceiling is "one to four sentences … short enough to speak aloud", and
//     ~600 characters is about 100 words — four short sentences. It is the persona's ceiling
//     written as a number, not a round number picked for looks;
//   * it sits well under CONVERSATION_PER_MESSAGE_CHARS (1500), so a reply that meets the budget
//     can never be sliced in the next turn's conversation block — the compounding loop above,
//     closed by construction rather than by hoping;
//   * Rob's offending reply was roughly 3,300 characters (743 tokens ≈ 550 words), so the target
//     is about 5.5x smaller than the thing he complained about.
//
// The unit is characters, not tokens or words, because the two bounds this reply is measured
// against are both in characters (the prompt-composition log line and the conversation block),
// and because a character count needs no tokeniser to be decided deterministically.

export const CONVERSATIONAL_REPLY_TARGET_CHARS = 600;

// The reply call's schema — the shape that removes the preamble and the markdown wrapper, and
// the place the length rule lives a second time (the persona is prose, and prose does not throw;
// a schema description is part of the contract the model is handed on every call).
export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: `Jarvis's complete reply, as plain prose with no preamble, no sign-off and no markdown wrapper. Match its length to the question. For an ordinary conversational turn keep it short enough to say aloud — usually one to four sentences, about ${CONVERSATIONAL_REPLY_TARGET_CHARS} characters at most — and put the substance in it rather than a report. Only go longer when the user actually asked for a report, plan, breakdown or other long-form answer.`,
    },
  },
  required: ['reply'],
};

// The repair pass's schema. Same one-field shape on purpose: a bounded, cheap rewrite that can
// only ever return a shorter reply.
export const REPAIR_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: `The rewritten reply, at most ${CONVERSATIONAL_REPLY_TARGET_CHARS} characters, keeping every fact, number, name and recommendation from the original and adding nothing new. Plain prose, same voice, no preamble, no markdown.`,
    },
  },
  required: ['reply'],
};

// Deliberately generous: ANY of these words means "treat this as long form and do not repair".
// The expensive mistake is shortening an answer the operator actually asked for, so an
// unrecognised message leans conversational (it is repairable, and the repair is lossless or
// skipped) while a message naming depth or an artifact is exempt outright.
const LONG_FORM_REQUEST = /\b(report|plan|roadmap|breakdown|break\s+(?:\w+\s+)?down|step[\s-]?by[\s-]?step|walk\s+me\s+through|in\s+depth|in\s+detail|detailed|analysis|analyse|analyze|assessment|audit|write[\s-]?up|document|list|compare|comparison|pros\s+and\s+cons|summar(?:y|ise|ize)|elaborate|expand\s+on|full\s+run[\s-]?down|rundown)\b/i;

/**
 * Is this message explicitly asking for a long-form answer (a report, a plan, a breakdown)?
 *
 * When it is, `shouldRepairReply` refuses to touch the reply however long it is: a user who asks
 * for a report must still get one. Pure and heuristic by design — see the header.
 *
 * @param {unknown} message the user's own words
 * @returns {boolean}
 */
export function isLongFormRequest(message) {
  return LONG_FORM_REQUEST.test(String(message == null ? '' : message));
}

/** The reply's length as the budget measures it: trimmed, in characters. */
export function replyCharCount(reply) {
  return String(reply == null ? '' : reply).trim().length;
}

/**
 * Should this reply be sent through the one bounded repair pass?
 *
 * The boundary is exact and asserted both ways: AT the target is fine, one character over is
 * not. An empty reply is never "repaired" — emptiness is refused by the caller, and a rewrite of
 * nothing would only manufacture content. A long-form turn is never repaired at all.
 *
 * @param {unknown} reply
 * @param {{longForm?: boolean, targetChars?: number}} [opts]
 * @returns {boolean}
 */
export function shouldRepairReply(reply, { longForm = false, targetChars = CONVERSATIONAL_REPLY_TARGET_CHARS } = {}) {
  const text = String(reply == null ? '' : reply).trim();
  if (!text) return false;
  if (longForm) return false;
  return text.length > targetChars;
}

/**
 * The reply text out of an `invokeAI` result.
 *
 * Tolerates a plain string as well as the schema's object: the handler's truncation fallback
 * re-asks without the schema, so both shapes reach this. Anything else is empty — and empty is
 * refused upstream rather than stored, which is the same rule an unusable payload gets in
 * `lib/deckInsightPayload.js`.
 *
 * @param {unknown} result
 * @returns {string}
 */
export function extractReply(result) {
  if (typeof result === 'string') return result.trim();
  if (result && typeof result === 'object' && typeof result.reply === 'string') return result.reply.trim();
  return '';
}

/**
 * What to store after the repair pass: the rewritten reply, or the ORIGINAL.
 *
 * The single decision between the model's rewrite and `deckJarvisMessage.create`, and it keeps
 * the original unless the rewrite is genuinely usable:
 *
 *   * a `truncated` rewrite keeps the original — a cut-off JSON object can still parse, so
 *     "the payload looks fine" is not evidence that the rewrite finished (H6);
 *   * a junk payload, a missing field or an empty string keeps the original — one cannot be
 *     manufactured from the other;
 *   * a rewrite that is NOT shorter than the original keeps the original: the pass can only
 *     help, never trade a verbose answer for an equally verbose one at the cost of a call.
 *
 * @param {{original?: unknown, result?: unknown, truncated?: boolean}} [input]
 * @returns {{repaired: boolean, reply: string, reason: 'repaired'|'truncated'|'unusable'|'no-shorter'}}
 */
export function repairDecision({ original, result, truncated = false } = {}) {
  const before = String(original == null ? '' : original).trim();
  if (truncated) return { repaired: false, reply: before, reason: 'truncated' };
  // Strictly the schema's object shape. A bare string is not a rewrite here: the repair call
  // always passes REPAIR_SCHEMA, so `invokeAI` either parses the object or throws — a string
  // means the provider ignored the contract, which is junk rather than a shorter reply.
  const candidate = result && typeof result === 'object' && typeof result.reply === 'string'
    ? result.reply.trim()
    : '';
  if (!candidate) return { repaired: false, reply: before, reason: 'unusable' };
  if (candidate.length >= before.length) return { repaired: false, reply: before, reason: 'no-shorter' };
  return { repaired: true, reply: candidate, reason: 'repaired' };
}

/**
 * The repair pass's whole prompt: the reply, the limit, and the one thing that makes it safe to
 * accept — keep every fact.
 *
 * @param {{reply?: unknown, targetChars?: number}} [input]
 * @returns {string}
 */
export function buildRepairPrompt({ reply, targetChars = CONVERSATIONAL_REPLY_TARGET_CHARS } = {}) {
  return `Rewrite the reply below so it is at most ${targetChars} characters — short enough to say aloud, usually one to four sentences.

Keep EVERY fact, number, name and recommendation that is in it. Remove padding, hedging, restatement and preamble, never substance. Add nothing new and change no claim. Keep the same voice.

Return only the rewritten reply.

REPLY TO REWRITE:
${String(reply == null ? '' : reply).trim()}`;
}
