// Pulls only genuine inquiries into the Inbox card — a customer question, a
// quote/price request, a repair or consignment enquiry, a submission from
// the valiantmusic.com.au website contact form, or anyone asking for help —
// not newsletters, marketing, or automated notifications. Filtering is the
// AI classification layer alone now — see the 2026-09-17 correction below
// for why the original "category:primary as a cheap first pass" layer got
// removed entirely, not just widened.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getDeckGoogleToken, listGmailMessages, getGmailMessage } from '../lib/deckGoogle.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';

const PAGE_SIZE = 20;
// 2026-09-17 (Rob: "emails are blowing out of their box" — a real inquiry,
// "a guy about dry hire", never showed up): a single sync used to fetch only
// the newest PAGE_SIZE primary-category messages, so once the backlog grew
// past that, older never-classified mail fell permanently outside the
// window and was never checked. Now pages backward (via
// DeckGmailSeenMessage's own seen-tracking, so nothing is ever
// re-classified twice) until it runs out of pages or hits this safety cap —
// bounded so one sync can't run away classifying an entire mailbox's history
// the first time it's ever run against a huge backlog.
const MAX_MESSAGES_PER_SYNC = 150;
// 2026-09-17 CORRECTION (Rob: "still not picking up" even after the paging
// fix above): checked this mailbox's actual Gmail data directly — `category:
// primary` returns ZERO messages for this account, ever, with no date bound.
// Every message, including an unambiguous genuine customer email ("Receipt"
// from a customer chasing an invoice), carries no CATEGORY_PERSONAL label at
// all; this account's inbox isn't using Gmail's tabbed-category feature the
// original two-layer design assumed. That "cheap first pass" wasn't cheaply
// filtering anything — it was silently returning an empty result set and
// making every sync a no-op from the day it shipped. Dropped entirely; the
// AI classification pass below is now the ONLY filter, exactly as the
// original code comment already called it ("the real filter") — it was
// already meant to carry this weight alone.
const GMAIL_QUERY = 'in:inbox';

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    isInquiry: {
      type: 'boolean',
      description: 'true only if this needs a personal reply from the account owner: a customer question, a quote/price request, a job/booking enquiry, a website contact-form submission, or someone asking for help.',
    },
  },
  required: ['isInquiry'],
};

async function classifyIsInquiry(userId, message) {
  const businessContext = await getDeckBusinessContext(userId);
  const prompt = `You are filtering Gmail for ${businessContext}. Decide whether the message below is a genuine inquiry the account owner needs to personally see and reply to — a customer question, a quote/price request, a job/booking/service enquiry, a submission from the business's own website contact form, or someone asking for help — or whether it's a newsletter, marketing email, automated notification, receipt, policy update, or anything else that doesn't need a personal reply.

If it's genuinely ambiguous — a real person, not obviously automated, asking about anything business-related even if loosely worded — lean toward true. Missing a real customer message is a much worse outcome than one extra item to mark done; a false "true" costs two seconds, a false "false" loses a customer who was never seen.

FROM: ${message.from}${message.fromEmail ? ` <${message.fromEmail}>` : ''}
SUBJECT: ${message.subject}
MESSAGE:
${(message.body || message.snippet || '').slice(0, 3000)}`;

  // One boolean, on the `classify` role (flash @ 0.4), which has no hidden-reasoning tax
  // to eat the budget — that tax was the cause of the OUTPUT_TRUNCATED this cap was raised
  // to outrun, back when this call named no role and so resolved to the platform default.
  // The caller must still not read a throw as "not an inquiry"; see its own handling.
  const { result } = await invokeAI({ userId, prompt, schema: CLASSIFY_SCHEMA, role: 'classify', maxTokens: 800 });
  return !!result?.isInquiry;
}

export default async function handler({ user }) {
  const { token } = await getDeckGoogleToken(user.id);

  let checked = 0;
  let created = 0;
  let failed = 0;
  let pageToken;

  // Walk pages newest-first until either: a page comes back with nothing
  // unseen (meaning we've reached mail already processed by a prior sync —
  // safe to infer since every sync walks in this same newest-to-oldest
  // order), there are no more pages, or the per-sync safety cap is hit.
  while (checked < MAX_MESSAGES_PER_SYNC) {
    const { messages, nextPageToken } = await listGmailMessages(token, { maxResults: PAGE_SIZE, query: GMAIL_QUERY, pageToken });
    if (messages.length === 0) break;

    const seen = await prisma.deckGmailSeenMessage.findMany({
      where: { created_by_id: user.id, external_id: { in: messages.map((m) => m.id) } },
      select: { external_id: true },
    });
    const seenIds = new Set(seen.map((r) => r.external_id));
    const unseen = messages.filter((m) => !seenIds.has(m.id));
    if (unseen.length === 0) break;

    for (const { id } of unseen) {
      const full = await getGmailMessage(token, id);
      checked++;

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

    if (!nextPageToken) break;
    pageToken = nextPageToken;
  }

  return { checked, created, skipped: checked - created - failed, failed };
}
