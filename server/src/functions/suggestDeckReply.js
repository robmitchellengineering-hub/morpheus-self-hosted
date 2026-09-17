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

  const { result: reply } = await invokeAI({ userId: user.id, prompt, maxTokens: MAX_REPLY_TOKENS });
  return { reply: reply.trim() };
}
