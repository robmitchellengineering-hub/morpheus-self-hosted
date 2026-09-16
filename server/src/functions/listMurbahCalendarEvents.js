// Two-way half of Calendar/Murbah sync — lists upcoming events back for
// display on the Murbah panel, filtered server-side (via Calendar's
// privateExtendedProperty) to exactly the events syncMurbahBooking.js
// created. Never touches or returns the rest of Rob's actual calendar.
import { getDeckGoogleToken, listCalendarEvents, MURBAH_CALENDAR_QUERY } from '../lib/deckGoogle.js';

export default async function handler({ user }) {
  const { token } = await getDeckGoogleToken(user.id);
  const events = await listCalendarEvents(token, { maxResults: 20, privateExtendedProperty: MURBAH_CALENDAR_QUERY });

  return {
    events: events.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.date || e.start?.dateTime || null,
      end: e.end?.date || e.end?.dateTime || null,
      htmlLink: e.htmlLink || null,
    })),
  };
}
