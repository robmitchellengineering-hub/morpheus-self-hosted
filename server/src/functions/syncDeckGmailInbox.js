// Pulls only genuine inquiries into the Inbox card — a customer question, a
// quote/price request, a repair or consignment enquiry, a submission from
// the valiantmusic.com.au website contact form, or anyone asking for help —
// not newsletters, marketing, or automated notifications. Two layers, per
// Rob's call: Gmail's own category:primary as a cheap first pass, then an
// AI classification per message as the real filter (category:primary alone
// still lets through plenty of "Updates"-adjacent mail Gmail doesn't sort
// away, e.g. a marketplace policy notice).
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getDeckGoogleToken, listGmailMessages, getGmailMessage } from '../lib/deckGoogle.js';

const MAX_MESSAGES = 20;
const GMAIL_QUERY = 'in:inbox category:primary';

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    isInquiry: {
      type: 'boolean',
      description: 'true only if this needs a personal reply from Rob: a customer question, a quote/price request, a repair or consignment enquiry, a website contact-form submission, or someone asking for help.',
    },
  },
  required: ['isInquiry'],
};

async function classifyIsInquiry(userId, message) {
  const prompt = `You are filtering Gmail for Valiant Music, an instrument sales/repair/consignment shop. Decide whether the message below is a genuine inquiry Rob needs to personally see and reply to (a customer question, a quote/price request, a repair or consignment enquiry, a submission from the valiantmusic.com.au website contact form, or someone asking for help) — or whether it's a newsletter, marketing email, automated notification, receipt, policy update, or anything else that doesn't need a personal reply.

FROM: ${message.from}${message.fromEmail ? ` <${message.fromEmail}>` : ''}
SUBJECT: ${message.subject}
MESSAGE:
${(message.body || message.snippet || '').slice(0, 3000)}`;

  // Deliberately generous even though the answer is one boolean — this
  // deployment's model can burn a real chunk of the token budget on hidden
  // reasoning before it ever emits the JSON (the same lesson chatWithJarvis
  // learned the hard way at 900 tokens). A too-tight cap here would throw
  // OUTPUT_TRUNCATED on the classification call itself, which the caller
  // must NOT silently read as "not an inquiry" — see the caller's own
  // handling of this throwing.
  const { result } = await invokeAI({ userId, prompt, schema: CLASSIFY_SCHEMA, maxTokens: 800 });
  return !!result?.isInquiry;
}

export default async function handler({ user }) {
  const { token } = await getDeckGoogleToken(user.id);

  const messages = await listGmailMessages(token, { maxResults: MAX_MESSAGES, query: GMAIL_QUERY });

  const seen = await prisma.deckGmailSeenMessage.findMany({
    where: { created_by_id: user.id, external_id: { in: messages.map((m) => m.id) } },
    select: { external_id: true },
  });
  const seenIds = new Set(seen.map((r) => r.external_id));
  const unseen = messages.filter((m) => !seenIds.has(m.id));

  let created = 0;
  let failed = 0;
  for (const { id } of unseen) {
    const full = await getGmailMessage(token, id);

    let isInquiry;
    try {
      isInquiry = await classifyIsInquiry(user.id, full);
    } catch (err) {
      // A failed classification (truncation, a transient provider error)
      // must NOT be treated as "not an inquiry" — that would permanently
      // drop a real customer message the moment DeckGmailSeenMessage marks
      // it seen below. Skip both the inbox item AND the seen-marker so this
      // message is simply reclassified on the next sync instead.
      console.error(`[syncDeckGmailInbox] classification failed for message ${id}:`, err.message);
      failed++;
      continue;
    }

    if (isInquiry) {
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

    await prisma.deckGmailSeenMessage.create({
      data: { created_by_id: user.id, external_id: full.id },
    }).catch(() => {}); // already-seen race between concurrent syncs — harmless
  }

  return { checked: messages.length, created, skipped: unseen.length - created - failed, failed };
}
