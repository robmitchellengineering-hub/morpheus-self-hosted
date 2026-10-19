import { prisma } from '../db.js';
import { getDeckGoogleToken, sendGmailMessage } from '../lib/deckGoogle.js';

export default async function handler({ user, body }) {
  const inboxItemId = body?.inboxItemId;
  const replyText = (body?.reply || '').trim();
  if (!inboxItemId) throw Object.assign(new Error('inboxItemId is required'), { status: 400 });
  if (!replyText) throw Object.assign(new Error('reply text is required'), { status: 400 });

  const item = await prisma.deckInboxItem.findFirst({ where: { id: inboxItemId, created_by_id: user.id } });
  if (!item) throw Object.assign(new Error('Inbox item not found'), { status: 404 });
  if (item.channel !== 'gmail' || !item.from_email) {
    throw Object.assign(new Error('This inbox item has no email address to reply to'), { status: 400 });
  }

  const { token } = await getDeckGoogleToken(user.id);
  await sendGmailMessage(token, {
    to: item.from_email,
    subject: `Re: message from ${item.from_name}`,
    body: replyText,
    inReplyToMessageId: item.external_id,
  });

  const updated = await prisma.deckInboxItem.update({ where: { id: item.id }, data: { stage: 'replied' } });
  return { item: updated };
}
