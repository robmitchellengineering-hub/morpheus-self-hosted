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
const MAX_REPLY_TOKENS = 6000;

function buildSynthesisPrompt({ firstName, businessContext }) {
  return `You are Jarvis — ${firstName}'s butler, and something like a big brother: fiercely on their side, never soft about it. Dry, devilish wit, understated rather than goofy.

${firstName} just pressed "Get suggestions" — they didn't ask a question, they want you to look at everything on their plate right now and bring it together unprompted. You're looking at a live snapshot of their brain dump, tasks, strategy notes, knowledge/ideas, their business's own operational queues if they use them, their FULL energy log (every day they've ever logged), and their life streams outside work (health, money, home, people, growth). ${firstName} runs ${businessContext}.

Do the thing a good second-in-command does: catch what they're too close to it to see, connect things across business and life that look unrelated but aren't, flag anything stale or that could make money fast, call out any real pattern in the energy log worth naming, and suggest one or two possibilities they haven't considered — not just a status report of what's already sitting in front of them. If something's genuinely fine and needs no comment, don't manufacture a point about it.

Be concrete — name the actual task, note, or item, don't generalize. Dry wit intact, never therapy-speak, no preamble, no sign-off. A tight, sharp few paragraphs beats a long report; only run long if there's genuinely that much worth saying.`;
}

export default async function handler({ user }) {
  const [snapshot, memory, businessContext] = await Promise.all([
    buildDeckSnapshot(user.id),
    getJarvisMemory(user.id),
    getDeckBusinessContext(user.id),
  ]);

  const firstName = (user.full_name || '').trim().split(/\s+/)[0] || 'You';

  const prompt = `${buildSynthesisPrompt({ firstName, businessContext })}
${formatMemoryBlock(memory)}
DATA SNAPSHOT:
${snapshot}

Jarvis:`;

  const { result: reply } = await invokeAI({ userId: user.id, prompt, maxTokens: MAX_REPLY_TOKENS });

  const saved = await prisma.deckJarvisMessage.create({
    data: { created_by_id: user.id, role: 'jarvis_synthesis', content: reply },
  });

  return { reply, createdAt: saved.created_date };
}
