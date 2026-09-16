// Live-probes Google rather than just checking a DeckGoogleConnection row
// exists — mirrors checkGoogleDriveConnection.js's same discipline.
import { getDeckGoogleConnection } from '../lib/deckGoogle.js';

export default async function handler({ user }) {
  const connection = await getDeckGoogleConnection(user.id);
  if (!connection?.token) return { connected: false, email: null };

  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!res.ok) return { connected: false, email: null };
    const data = await res.json();
    return { connected: true, email: data.email || connection.email };
  } catch (error) {
    return { connected: false, email: null, error: error.message };
  }
}
