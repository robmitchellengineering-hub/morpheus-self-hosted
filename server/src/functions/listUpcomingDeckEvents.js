// The generic Calendar widget's own list (Rob, 2026-09-17: alongside Inbox,
// the two widgets every account should get by default). Deliberately NOT
// filtered by privateExtendedProperty — unlike listMurbahCalendarEvents.js,
// which only shows events that feature created, this widget is meant to
// show the account's real upcoming calendar, same Google connection
// (DeckGoogleConnection) Signal Chain's Murbah sync already uses.
import { getDeckGoogleToken, listCalendarEvents } from '../lib/deckGoogle.js';

export default async function handler({ user }) {
  const { token } = await getDeckGoogleToken(user.id);
  const events = await listCalendarEvents(token, { maxResults: 20 });

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
