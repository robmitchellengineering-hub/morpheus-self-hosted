import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';

// Generous even for a short reply — this deployment's model can burn a real
// chunk of the budget on hidden reasoning before the actual text (the same
// lesson chatWithJarvis.js learned the hard way at 900 tokens).
const MAX_REPLY_TOKENS = 2000;

export default async function handler({ user, body }) {
  const inboxItemId = body?.inboxItemId;
  if (!inboxItemId) throw Object.assign(new Error('inboxItemId is required'), { status: 400 });

  const item = await prisma.deckInboxItem.findFirst({ where: { id: inboxItemId, created_by_id: user.id } });
  if (!item) throw Object.assign(new Error('Inbox item not found'), { status: 404 });

  const prompt = `You are drafting a reply on behalf of Rob Mitchell, who runs Valiant Music (instrument sales, repairs, consignment). Write a short, warm, professional reply to the message below. Match his plain, direct tone — no corporate filler. Sign off as "Rob". Output only the reply body text, nothing else.

FROM: ${item.from_name}${item.from_email ? ` <${item.from_email}>` : ''}
MESSAGE:
${item.message}`;

  const { result: reply } = await invokeAI({ userId: user.id, prompt, maxTokens: MAX_REPLY_TOKENS });
  return { reply: reply.trim() };
}
