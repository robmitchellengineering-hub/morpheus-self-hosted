import { prisma } from '../db.js';
import { getDeckGoogleToken, listGmailMessages, getGmailMessage } from '../lib/deckGoogle.js';

const MAX_MESSAGES = 15;

export default async function handler({ user }) {
  const { token } = await getDeckGoogleToken(user.id);

  const existing = await prisma.deckInboxItem.findMany({
    where: { created_by_id: user.id, external_id: { not: null } },
    select: { external_id: true },
  });
  const known = new Set(existing.map((r) => r.external_id));

  const messages = await listGmailMessages(token, { maxResults: MAX_MESSAGES });
  const newOnes = messages.filter((m) => !known.has(m.id));

  let created = 0;
  for (const { id } of newOnes) {
    const full = await getGmailMessage(token, id);
    await prisma.deckInboxItem.create({
      data: {
        created_by_id: user.id,
        channel: 'gmail',
        from_name: full.from,
        from_email: full.fromEmail,
        message: full.body?.slice(0, 5000) || full.snippet || '',
        stage: 'new',
        external_id: full.id,
      },
    });
    created++;
  }

  return { checked: messages.length, created };
}
