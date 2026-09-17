// The generic Calendar widget's quick-add (Rob, 2026-09-17). A plain
// all-day event, no DeckMurbahOpportunity tracking or extended-properties
// tagging — that bookkeeping is specific to Signal Chain's own Murbah↔
// Calendar sync (syncMurbahBooking.js). This is a one-shot create straight
// to the account's real Google Calendar.
import { getDeckGoogleToken, insertCalendarEvent } from '../lib/deckGoogle.js';

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async function handler({ user, body }) {
  const summary = (body?.summary || '').trim();
  const date = (body?.date || '').trim();
  if (!summary) throw Object.assign(new Error('summary is required'), { status: 400 });
  if (!date) throw Object.assign(new Error('date is required'), { status: 400 });

  const { token } = await getDeckGoogleToken(user.id);

  const startDate = new Date(date);
  if (Number.isNaN(startDate.getTime())) throw Object.assign(new Error('Invalid date'), { status: 400 });
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + 1); // Calendar all-day events use an exclusive end date

  const event = await insertCalendarEvent(token, {
    summary,
    start: { date: isoDate(startDate) },
    end: { date: isoDate(endDate) },
  });

  return { id: event.id, htmlLink: event.htmlLink || null };
}
