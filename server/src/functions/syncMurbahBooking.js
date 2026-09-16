// Pushes a Murbah opportunity's booking_date to Google Calendar as an
// all-day event, creating it the first time and updating it in place on
// later syncs (tracked via calendar_event_id) rather than creating
// duplicates. Every event is tagged with MURBAH_CALENDAR_EXTENDED_PROPERTIES
// so listMurbahCalendarEvents.js can list back exactly these events, never
// the rest of Rob's actual calendar — see lib/deckGoogle.js.
import { prisma } from '../db.js';
import { getDeckGoogleToken, insertCalendarEvent, updateCalendarEvent, MURBAH_CALENDAR_EXTENDED_PROPERTIES } from '../lib/deckGoogle.js';

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async function handler({ user, body }) {
  const opportunityId = body?.opportunityId;
  if (!opportunityId) throw Object.assign(new Error('opportunityId is required'), { status: 400 });

  const opp = await prisma.deckMurbahOpportunity.findFirst({ where: { id: opportunityId, created_by_id: user.id } });
  if (!opp) throw Object.assign(new Error('Murbah opportunity not found'), { status: 404 });
  if (!opp.booking_date) throw Object.assign(new Error('Set a booking date first'), { status: 400 });

  const { token } = await getDeckGoogleToken(user.id);

  const startDate = opp.booking_date;
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + 1); // Calendar all-day events use an exclusive end date

  const eventFields = {
    summary: `Murbah — ${opp.title}`,
    description: opp.note || '',
    start: { date: isoDate(startDate) },
    end: { date: isoDate(endDate) },
  };

  let eventId = opp.calendar_event_id;
  let event;
  if (eventId) {
    try {
      event = await updateCalendarEvent(token, eventId, eventFields);
    } catch {
      // Stale/deleted event id (e.g. removed by hand in Calendar) — create
      // a fresh one instead of failing the whole sync.
      event = await insertCalendarEvent(token, { ...eventFields, extendedProperties: MURBAH_CALENDAR_EXTENDED_PROPERTIES });
      eventId = event.id;
    }
  } else {
    event = await insertCalendarEvent(token, { ...eventFields, extendedProperties: MURBAH_CALENDAR_EXTENDED_PROPERTIES });
    eventId = event.id;
  }

  await prisma.deckMurbahOpportunity.update({ where: { id: opp.id }, data: { calendar_event_id: eventId } });

  return { eventId, htmlLink: event.htmlLink || null };
}
