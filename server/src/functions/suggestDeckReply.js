import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';

// Generous even for a short reply — this deployment's model can burn a real
// chunk of the budget on hidden reasoning before the actual text (the same
// lesson chatWithJarvis.js learned the hard way at 900 tokens).
const MAX_REPLY_TOKENS = 2000;

export default async function handler({ user, body }) {
  const inboxItemId = body?.inboxItemId;
  if (!inboxItemId) throw Object.assign(new Error('inboxItemId is required'), { status: 400 });

  const item = await prisma.deckInboxItem.findFirst({ where: { id: inboxItemId, created_by_id: user.id } });
  if (!item) throw Object.assign(new Error('Inbox item not found'), { status: 404 });

  const businessContext = await getDeckBusinessContext(user.id);
  const signOff = (user.full_name || '').trim().split(/\s+/)[0] || 'the team';

  const prompt = `You are drafting a reply on behalf of ${user.full_name || 'the account owner'}, who runs ${businessContext}. Write a short, warm, professional reply to the message below. Match a plain, direct tone — no corporate filler. Sign off as "${signOff}". Output only the reply body text, nothing else.

FROM: ${item.from_name}${item.from_email ? ` <${item.from_email}>` : ''}
MESSAGE:
${item.message}`;

  // `role: 'draft'` — mechanical prose, not persona. This named NO role, so it silently
  // resolved to default_model (v4-pro @ 0.7): a reasoning model spending its budget
  // thinking before it writes a short reply, at the same 0.7 the persona paths use for
  // judgement. Rob's call, 2026-09-27, after the same swap measured 8x cheaper and ~2s
  // faster per message on the deck's widget-build classifier. Naming the role is also what
  // makes it tunable and A/B-able at all — a role-less call has no per-user override.
  const { result: reply } = await invokeAI({ userId: user.id, prompt, maxTokens: MAX_REPLY_TOKENS, role: 'draft' });

  const draft = String(reply || '').trim();
  if (!draft) {
    // A 200 with an empty body used to come back as a successful `{ reply: '' }`, so the
    // reply box was simply blank — indistinguishable from "Jarvis had nothing to say" —
    // and `reply.trim()` threw outright on a null result, which the client reported as a
    // SAVE failure. Throw the honest thing instead; the caller shows the reason.
    throw new Error('Jarvis returned an empty draft — nothing to insert. Ask again.');
  }

  return { reply: draft };
}
