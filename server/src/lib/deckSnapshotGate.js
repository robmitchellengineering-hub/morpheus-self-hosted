// What context does this turn actually need — the Deck snapshot, and which career briefs?
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
// 2026-10-04 — the same call now also picks the career briefs (Rob: *"fill out the
// carreers with specialized knowlage ... referencable quickly"*). Same lever, same
// reason: 36 briefs is ~4,000 tokens a message, so at most three are attached, and the
// classifier that already reads the message is what chooses them. One call, not two.
//
// ⚠️ THE TWO FAILURE DIRECTIONS ARE OPPOSITE, AND BOTH ARE LOAD-BEARING
//
// SNAPSHOT — fail OPEN. Only an explicit, usable `false` drops it. A timeout, a
// truncation, an unparsable answer, a missing field, a string, a number — anything that
// is not the boolean `false` — INCLUDES it. A false "no deck needed" answers a real
// question blind; a false "deck needed" costs tokens. Prefer the tokens: this must never
// narrow what Jarvis can answer. (`shouldIncludeSnapshot`.)
//
// CAREERS — fail EMPTY. There is no headroom to fail open into: including all 36 briefs
// is ~4,000 tokens. So anything unusable yields `[]`. That is safe rather than a
// compromise, because the 36 names are always in the persona: with no brief he answers
// exactly as he did before this existed, from the model's own knowledge, in character.
// A failed selection is LESS SHARP, never wrong and never blind. (`selectedCareerKeys`.)
//
// Import-free apart from the register (which is itself strings only), like
// `deckMemoryText.js` / `deckInsightPayload.js`, so the guards can run in CI's
// no-install job (a guard that cannot run is not a pass).
import { CAREER_KEYS } from './jarvisCareers.js';

/** More than this and the briefs stop being a shorthand and start being the problem again. */
export const MAX_SELECTED_CAREERS = 3;

export const SNAPSHOT_NEED_SCHEMA = {
  type: 'object',
  properties: {
    needsSnapshot: {
      type: 'boolean',
      description: 'True if answering this message well requires the user\'s own Deck data (their tasks, notes, brain dump, queues, energy log or life streams) — a question about them, their business, or their life. False ONLY for a message that needs none of it: a greeting, thanks, banter, or a question about you or about something general.',
    },
    careers: {
      type: 'array',
      items: { type: 'string' },
      description: `Up to ${MAX_SELECTED_CAREERS} of Jarvis's past careers whose practitioner judgement would change the answer, copied EXACTLY from the list in the prompt. An empty array is the normal answer for a greeting, small talk, a question about the user's own Deck data, or anything general.`,
    },
  },
  required: ['needsSnapshot', 'careers'],
};

/** The classifier's whole prompt: the message, and the questions being asked. */
export function buildSnapshotNeedPrompt(message) {
  return `A Command Deck user sent this message:

MESSAGE: "${message}"

Does answering it WELL require their own Deck data — their tasks, brain dump, strategy/knowledge notes, business queues, energy log or life streams?

Answer true for anything about them, their business or their life: what is on their plate, how they are tracking, what they should do next, anything that names or implies their own items.

Answer false ONLY for a message that needs none of that: a greeting, a thank-you, a joke, small talk, or a question about you or about something general.

When it is not clearly a false, answer true — a wrong "true" only costs some tokens, a wrong "false" leaves you answering blind.

Separately: which of his past careers, if any, is this message asking about? Choose AT MOST ${MAX_SELECTED_CAREERS}, copied exactly from this list, or an empty list if none apply:

${CAREER_KEYS.join(', ')}

Choose a career only when a practitioner's judgement would change the answer — someone asking for legal, medical, tax, engineering, safety or similar advice. A greeting, small talk, a question about their own data, or general chat gets an empty list. Fewer is better: one right career beats three approximate ones.`;
}

/**
 * The snapshot decision, unchanged: include unless the classifier said an explicit, usable `false`.
 *
 * @param {unknown} classifierResult invokeAI's parsed result (or anything else at all)
 * @returns {boolean}
 */
export function shouldIncludeSnapshot(classifierResult) {
  return classifierResult?.needsSnapshot !== false;
}

/**
 * Which career briefs to attach — the opposite failure direction from the snapshot, on purpose.
 *
 * Anything unusable (no array, a string, junk, an unknown name, a runaway list) yields `[]` or is
 * dropped, never a guess and never a crash. Unknown names are dropped rather than trusted: the
 * register is the only thing that may decide what a career is called, so a classifier cannot invent
 * one and have it interpolated into a prompt.
 *
 * @param {unknown} classifierResult invokeAI's parsed result (or anything else at all)
 * @returns {string[]} zero to MAX_SELECTED_CAREERS known career keys, in the order given
 */
export function selectedCareerKeys(classifierResult) {
  const raw = classifierResult?.careers;
  if (!Array.isArray(raw)) return [];
  const chosen = [];
  for (const item of raw) {
    const key = String(item ?? '').trim();
    if (!CAREER_KEYS.includes(key)) continue;
    if (chosen.includes(key)) continue;
    chosen.push(key);
    if (chosen.length >= MAX_SELECTED_CAREERS) break;
  }
  return chosen;
}
