// Does this message need the live Deck snapshot at all?
//
// WHY THIS EXISTS (2026-10-03, measured)
//
// `chatWithJarvis.js` built the whole snapshot unconditionally and interpolated it into
// every prompt: persona + rules ≈ 690 tokens, the live snapshot ≈ 2,400 tokens — the
// snapshot was 78% of the prompt, on every call, including "say hello to my sister".
// The lever on the reply's latency is INPUT TOKENS, not model choice (see
// MODEL-DECISIONS.md), so the fix is to stop sending the snapshot to a question that
// does not need it.
//
// THE FAILURE DIRECTION IS LOAD-BEARING
//
// Only an explicit, usable `false` from the classifier drops the snapshot. A timeout, a
// truncation, an unparsable answer, a missing field, a string, a number — anything that
// is not the boolean `false` — INCLUDES it. A false "no deck needed" answers a real
// question blind; a false "deck needed" costs tokens. Prefer the tokens: this must never
// narrow what Jarvis can answer. That rule lives in `shouldIncludeSnapshot` and is
// asserted with fixtures in scripts/verify-jarvis-snapshot-gate.mjs.
//
// Import-free on purpose, like `deckMemoryText.js` / `deckInsightPayload.js`, so that
// guard can run in CI's no-install guards job (a guard that cannot run is not a pass).

export const SNAPSHOT_NEED_SCHEMA = {
  type: 'object',
  properties: {
    needsSnapshot: {
      type: 'boolean',
      description: 'True if answering this message well requires the user\'s own Deck data (their tasks, notes, brain dump, queues, energy log or life streams) — a question about them, their business, or their life. False ONLY for a message that needs none of it: a greeting, thanks, banter, or a question about you or about something general.',
    },
  },
  required: ['needsSnapshot'],
};

/** The classifier's whole prompt: the message, and the one question being asked. */
export function buildSnapshotNeedPrompt(message) {
  return `A Command Deck user sent this message:

MESSAGE: "${message}"

Does answering it WELL require their own Deck data — their tasks, brain dump, strategy/knowledge notes, business queues, energy log or life streams?

Answer true for anything about them, their business or their life: what is on their plate, how they are tracking, what they should do next, anything that names or implies their own items.

Answer false ONLY for a message that needs none of that: a greeting, a thank-you, a joke, small talk, or a question about you or about something general.

When it is not clearly a false, answer true — a wrong "true" only costs some tokens, a wrong "false" leaves you answering blind.`;
}

/**
 * The failure direction, as one function: include the snapshot unless the classifier
 * gave an explicit, usable `false`.
 *
 * @param {unknown} classifierResult invokeAI's parsed result (or anything else at all)
 * @returns {boolean}
 */
export function shouldIncludeSnapshot(classifierResult) {
  return classifierResult?.needsSnapshot !== false;
}
