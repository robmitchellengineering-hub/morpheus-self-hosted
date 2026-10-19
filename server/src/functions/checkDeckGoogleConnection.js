// Live-probes Google rather than just checking a DeckGoogleConnection row
// exists — mirrors checkGoogleDriveConnection.js's same discipline.
import { prisma } from '../db.js';
import { getDeckGoogleConnection } from '../lib/deckGoogle.js';

export default async function handler({ user }) {
  let connection;
  try {
    connection = await getDeckGoogleConnection(user.id);
  } catch (err) {
    // A dead credential must be reported as needing a reconnect, not as an error the operator has
    // to interpret — and never as "connected". The `reason` is what the Settings line says.
    if (err?.code === 'GOOGLE_RECONNECT_REQUIRED') {
      return { connected: false, email: null, lastBackupAt: null, needsReconnect: true, reason: err.reason, message: err.message };
    }
    throw err;
  }
  if (!connection?.token) return { connected: false, email: null, lastBackupAt: null };

  const row = await prisma.deckGoogleConnection.findUnique({ where: { created_by_id: user.id }, select: { last_backup_at: true } });
  const lastBackupAt = row?.last_backup_at?.toISOString() || null;

  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!res.ok) return { connected: false, email: null, lastBackupAt };
    const data = await res.json();
    return { connected: true, email: data.email || connection.email, lastBackupAt };
  } catch (error) {
    return { connected: false, email: null, lastBackupAt, error: error.message };
  }
}
