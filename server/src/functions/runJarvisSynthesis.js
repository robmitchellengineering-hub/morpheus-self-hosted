// The Jarvis "Get suggestions" card (Rob, 2026-09-17: "the one you just
// press a button called get suggestions and this is where he brings it all
// together... he'll catch things you miss and think of possibilities you
// never have") — scoped in the original Phase 2 plan, never actually built.
// Unlike chatWithJarvis.js, there's no question to answer: this is a
// one-shot, self-triggered synthesis over the same live snapshot, so the
// prompt asks Jarvis to proactively connect the dots rather than respond to
// anything. The result is persisted as an ordinary DeckJarvisMessage (role
// "jarvis_synthesis" — a plain string, no schema change needed) so it shows
// up in Jarvis's own conversation history and long-term memory exactly like
// any other reply, and DeckHome's card can just pull the latest one back out
// of the same message list it already loads.
//
// 2026-09-19 — TWO TRIGGERS, ONE IMPLEMENTATION.
//
// This was button-only, which made the product's own promise untrue: the PDF
// sells "tell you that before you notice it yourself", but a button you press
// when you already suspect something is the opposite of that, and it is
// exactly what every competitor already does. synthesizeDeck() now takes a
// `trigger`:
//
//   manual    — prose shown in the Deck, and now bounded by the SAME schema the
//               scheduled path uses. It used to pass no schema at all, so it
//               rambled to its cap; see the MAX_REPLY_TOKENS note below.
//   scheduled — deckInsight.js calls it unprompted. Two differences matter:
//               a prompt that doesn't claim the user just pressed a button
//               (they didn't — putting words in Jarvis's mouth about what the
//               operator did is the kind of small lie that erodes trust in
//               everything else he says), and a quiet day is a legitimate
//               outcome rather than something the caller must refuse.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getJarvisMemory, formatMemoryBlock } from '../lib/deckMemory.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';
import { buildDeckSnapshot } from '../lib/deckSnapshot.js';
import { interpretScheduledResult, synthesisMessageToStore } from '../lib/deckInsightPayload.js';

// 2026-09-17: tried capping this at 2000 to bound worst-case generation
// time (see PR #165) — broke correctness instead: this model burns a real
// chunk of the budget on hidden reasoning before any visible reply text
// (same behavior chatWithJarvis.js's own MAX_REPLY_TOKENS comment already
// flags), and 2000 wasn't enough to get past that, so the call returned a
// 200 with a silently EMPTY reply. Reverted to match chatWithJarvis's own
// proven ceiling.
//
// 2026-10-03 — CORRECTION, because this file's own comment used to claim "the budget is
// the lever, not the model" and that is wrong. The MANUAL path's 61/53/59-second runs on
// 2026-10-02 were not a budget problem: the path passed no schema, so nothing bounded the
// answer and it ran to the cap every time. Raising the cap moved the wall, it did not
// remove it. The fix is the SHAPE (`SCHEDULED_SCHEMA`, which can decline), not the
// ceiling — the scheduled cap above was raised for a real truncation, but manual was left
// at 6000 with no schema, which is the opposite of the measured rule (input/shape is the
// lever; model choice and, on its own, the cap are not).
//
// The scheduled cap's own record, kept: it shared 6000 with the conversational reply and hit
// the ceiling — `[deck-insight] … failed: OUTPUT_TRUNCATED (role=unknown, maxTokens=6000)`
// appears four times in the week to 2026-09-26 for a single account, and five role-less calls
// reached 6000 output tokens. That is why the batch job's ceiling is 12000.
const MAX_SCHEDULED_TOKENS = 12000;
const MAX_REPLY_TOKENS = 6000;

const SHARED_PERSONA = (firstName, businessContext) =>
  `You are Jarvis — ${firstName}'s butler, and something like a big brother: fiercely on their side, never soft about it. Dry, devilish wit, understated rather than goofy.`;

// "FULL energy log (every day they've ever logged)" was a promise this prompt could not
// keep once the snapshot capped the log at 3650 days, and a claim like that is exactly what
// a model will report as fact. The snapshot line itself now says which of how many days it
// is showing; the persona does not assert completeness at all.
const SHARED_DATA =
  `You're looking at a live snapshot of their brain dump, tasks, strategy notes, knowledge/ideas, their business's own operational queues if they use them, their energy log (every day they've logged, most recent first), and their life streams outside work (health, money, home, people, growth).`;

function buildManualPrompt({ firstName, businessContext }) {
  return `${SHARED_PERSONA(firstName, businessContext)}

${firstName} just pressed "Get suggestions" — they didn't ask a question, they want you to look at everything on their plate right now and bring it together unprompted. ${SHARED_DATA} ${firstName} runs ${businessContext}.

Do the thing a good second-in-command does: catch what they're too close to it to see, connect things across business and life that look unrelated but aren't, flag anything stale or that could make money fast, call out any real pattern in the energy log worth naming, and suggest one or two possibilities they haven't considered — not just a status report of what's already sitting in front of them. If something's genuinely fine and needs no comment, don't manufacture a point about it.

Be concrete — name the actual task, note, or item, don't generalize. Dry wit intact, never therapy-speak, no preamble, no sign-off. A tight, sharp few paragraphs beats a long report; only run long if there's genuinely that much worth saying.`;
}

// The scheduled prompt. Its single most important job is giving Jarvis
// PERMISSION TO SAY NOTHING — a periodic check-in that is obliged to produce a
// paragraph will produce one, and a daily manufactured insight is worse than
// none: it teaches the operator to ignore the card.
function buildScheduledPrompt({ firstName, businessContext }) {
  return `${SHARED_PERSONA(firstName, businessContext)}

This is your own periodic check-in — nobody asked, and ${firstName} is not waiting on an answer. ${SHARED_DATA} ${firstName} runs ${businessContext}.

Your only job is to decide whether anything in that snapshot is worth INTERRUPTING them for. Worth raising means: a connection across two domains they would not have made themselves (spending against workload, sleep against what got booked, an operational queue against who is carrying it), something quietly going stale that they would only notice too late, or a pattern in the energy log that has become too consistent to be noise.

NOT worth raising: a status summary, anything already obvious from looking at the Deck, a restatement of their own notes back to them, or advice they did not ask for and cannot act on today. If nothing meets that bar, say so — return worthRaising false. That is the correct answer most days, and it is a better outcome than finding something to say.

When you do raise something: name the actual items and the specific link between them, in a tight few sentences. No preamble, no sign-off, no therapy-speak. Dry wit intact.`;
}

const SCHEDULED_SCHEMA = {
  type: 'object',
  properties: {
    worthRaising: {
      type: 'boolean',
      description: 'True ONLY if this genuinely warrants interrupting them today. False is the expected answer most days.',
    },
    insight: {
      type: 'string',
      description: 'The insight itself when worthRaising is true — a few concrete sentences naming the actual items and the cross-domain link. Empty string when false.',
    },
  },
  required: ['worthRaising', 'insight'],
};

/**
 * Run Jarvis's cross-domain synthesis for one user.
 *
 * @param {{id: string, full_name?: string|null}} user
 * @param {{trigger?: 'manual'|'scheduled'}} [opts]
 * @returns {Promise<{reply?: string, createdAt?: Date, skipped?: boolean, reason?: string, trigger: string}>}
 */
export async function synthesizeDeck(user, { trigger = 'manual' } = {}) {
  const [snapshot, memory, businessContext] = await Promise.all([
    buildDeckSnapshot(user.id),
    getJarvisMemory(user.id),
    getDeckBusinessContext(user.id),
  ]);

  const firstName = (user.full_name || '').trim().split(/\s+/)[0] || 'You';
  const body = `${formatMemoryBlock(memory)}
DATA SNAPSHOT:
${snapshot}

Jarvis:`;

  if (trigger === 'scheduled') {
    const prompt = `${buildScheduledPrompt({ firstName, businessContext })}\n${body}`;
    const { result } = await invokeAI({
      userId: user.id,
      prompt,
      maxTokens: MAX_SCHEDULED_TOKENS,
      schema: SCHEDULED_SCHEMA,
    });

    // `result` is already an object — invokeAI parses it when a schema is passed.
    // This used to be `JSON.parse(result)`, which threw on every single successful
    // call and made the whole feature a no-op that reported itself as healthy; see
    // lib/deckInsightPayload.js.
    const outcome = interpretScheduledResult(result);
    if (!outcome.ok) {
      // LOUD on purpose: an unusable payload is a DEFECT, not a quiet day, and
      // folding it into the skip count is how this stayed invisible.
      console.warn(`[deck-insight] scheduled payload unusable (${outcome.reason}) for ${user.id} — nothing raised`);
      return { skipped: true, reason: outcome.reason, trigger };
    }
    if (!outcome.raise) {
      // The ordinary quiet outcome: Jarvis looked and found nothing worth
      // interrupting for. Deliberately kept distinct from the branch above.
      return { skipped: true, reason: 'nothing-to-raise', trigger };
    }

    const insight = outcome.insight;

    const saved = await prisma.deckJarvisMessage.create({
      data: { created_by_id: user.id, role: 'jarvis_synthesis', content: insight },
    });
    return { reply: insight, createdAt: saved.created_date, trigger };
  }

  // ── manual: prose in the Deck, but bounded by its SHAPE, not by a cap ──────
  //
  // Role: `planner`. It is the one role that resolves to exactly what this path already
  // ran on — `default_planner_model` is deepseek-v4-pro and `default_planner_temperature`
  // is 0.7, i.e. the platform default the persona deliberately sits on (MODEL-DECISIONS:
  // persona and judgement stay on pro, Rob's call). Naming it changes the model choice by
  // NOTHING and makes it visible; and if those settings are ever moved, this path moves
  // with them, which is the intended coupling between the two persona surfaces. The
  // SCHEDULED branch keeps its role-less call on purpose — bounding manual's output shape
  // is this change, moving the batch job's model is not.
  const prompt = `${buildManualPrompt({ firstName, businessContext })}\n${body}`;
  let result;
  let truncated = false;
  try {
    ({ result, truncated = false } = await invokeAI({
      userId: user.id,
      prompt,
      maxTokens: MAX_REPLY_TOKENS,
      schema: SCHEDULED_SCHEMA,
      role: 'planner',
    }));
  } catch (err) {
    // H6: `invokeAI` throws OUTPUT_TRUNCATED on a completion the provider cut off. Nothing
    // has been written yet and nothing will be — a half-finished insight is worse than none
    // — and the operator is told which of the two happened rather than a bare provider
    // error. (This is the failure the manual path used to hit on EVERY press: no schema, so
    // it rambled to the 6000 cap, got cut off, and stored nothing.)
    if (/^OUTPUT_TRUNCATED/.test(err?.message || '')) {
      console.warn(`[deck-synthesis] manual synthesis was truncated for ${user.id} — nothing stored`);
      throw new Error('Jarvis was cut off before finishing — nothing was stored. Ask again.');
    }
    throw err;
  }

  // One decision, in one place: `synthesisMessageToStore` refuses a truncation, a decline,
  // an empty answer and an unusable payload, and only ever yields the interpreted text.
  const decision = synthesisMessageToStore({ result, truncated });
  if (!decision.ok) {
    // An empty manual synthesis used to be stored as a blank "Suggestions" card with
    // no error on screen — indistinguishable from Jarvis having nothing to say. Refuse
    // it instead, and let the caller show that the synthesis failed. A decline is the
    // same refusal: the button asked for an insight, and there is not one to store.
    console.warn(`[deck-synthesis] manual synthesis produced nothing (${decision.reason}) for ${user.id} — nothing stored`);
    throw new Error(decision.reason === 'nothing-to-raise'
      ? 'Jarvis had nothing worth raising this time — nothing was stored.'
      : 'Jarvis returned an unusable synthesis — nothing was stored. Ask again.');
  }

  const saved = await prisma.deckJarvisMessage.create({
    data: { created_by_id: user.id, role: 'jarvis_synthesis', content: decision.content },
  });

  return { reply: decision.content, createdAt: saved.created_date, trigger };
}

export default async function handler({ user }) {
  return synthesizeDeck(user, { trigger: 'manual' });
}
