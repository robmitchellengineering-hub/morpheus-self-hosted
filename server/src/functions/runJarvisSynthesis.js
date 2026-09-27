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
//   manual    — unchanged. Prose reply, no schema, exactly as before.
//   scheduled — deckInsight.js calls it unprompted. Two differences matter:
//               a schema so the run can DECLINE to raise anything, and a
//               prompt that doesn't claim the user just pressed a button
//               (they didn't — putting words in Jarvis's mouth about what the
//               operator did is the kind of small lie that erodes trust in
//               everything else he says).
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getJarvisMemory, formatMemoryBlock } from '../lib/deckMemory.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';
import { buildDeckSnapshot } from '../lib/deckSnapshot.js';

// 2026-09-17: tried capping this at 2000 to bound worst-case generation
// time (see PR #165) — broke correctness instead: this model burns a real
// chunk of the budget on hidden reasoning before any visible reply text
// (same behavior chatWithJarvis.js's own MAX_REPLY_TOKENS comment already
// flags), and 2000 wasn't enough to get past that, so the call returned a
// 200 with a silently EMPTY reply. Reverted to match chatWithJarvis's own
// proven ceiling — this call is genuinely slow (~50s live-tested), but
// that's a real wait, not a bug; the frontend already shows a loading
// state for it. Fixing the wait time is a separate problem (a bigger
// compute plan, or trimming the snapshot/prompt itself), not this cap.
// The scheduled insight is a batch job, not an interactive reply, so it can afford the
// tokens a longer answer needs. It shared this 6000 with the conversational reply and
// hit the ceiling: `[deck-insight] … failed: OUTPUT_TRUNCATED (role=unknown,
// maxTokens=6000)` appears four times in the week to 2026-09-26 for a single account,
// and five role-less calls reached 6000 output tokens. `role=unknown` is deliberate —
// this is the persona path, on the platform default — so the budget is the lever, not
// the model.
const MAX_SCHEDULED_TOKENS = 12000;
const MAX_REPLY_TOKENS = 6000;

const SHARED_PERSONA = (firstName, businessContext) =>
  `You are Jarvis — ${firstName}'s butler, and something like a big brother: fiercely on their side, never soft about it. Dry, devilish wit, understated rather than goofy.`;

const SHARED_DATA =
  `You're looking at a live snapshot of their brain dump, tasks, strategy notes, knowledge/ideas, their business's own operational queues if they use them, their FULL energy log (every day they've ever logged), and their life streams outside work (health, money, home, people, growth).`;

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

    let parsed = null;
    try {
      parsed = JSON.parse(result);
    } catch {
      // A scheduled run must never persist a malformed object into Jarvis's
      // conversation history — better to have produced nothing.
      return { skipped: true, reason: 'unparseable', trigger };
    }

    const insight = String(parsed?.insight || '').trim();
    if (!parsed?.worthRaising || !insight) {
      return { skipped: true, reason: 'nothing-to-raise', trigger };
    }

    const saved = await prisma.deckJarvisMessage.create({
      data: { created_by_id: user.id, role: 'jarvis_synthesis', content: insight },
    });
    return { reply: insight, createdAt: saved.created_date, trigger };
  }

  // ── manual: unchanged, prose, no schema ───────────────────────────────────
  const prompt = `${buildManualPrompt({ firstName, businessContext })}\n${body}`;
  const { result: reply } = await invokeAI({ userId: user.id, prompt, maxTokens: MAX_REPLY_TOKENS });

  const saved = await prisma.deckJarvisMessage.create({
    data: { created_by_id: user.id, role: 'jarvis_synthesis', content: reply },
  });

  return { reply, createdAt: saved.created_date, trigger };
}

export default async function handler({ user }) {
  return synthesizeDeck(user, { trigger: 'manual' });
}
