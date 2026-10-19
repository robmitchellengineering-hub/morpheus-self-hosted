// Live-probes Drive rather than just checking a GoogleDriveConnection row
// exists — same discipline as checkGithubConnection.js, for the same
// reason: a revoked/expired connection should stop showing "Connected" the
// moment it's actually dead, not just when a push/pull next fails.
import { getGoogleDriveConnection, driveJson } from '../lib/googleDrive.js';

export default async function handler({ user }) {
  let connection;
  try {
    connection = await getGoogleDriveConnection(user.id);
  } catch (err) {
    if (err?.code === 'GOOGLE_RECONNECT_REQUIRED') {
      return { connected: false, email: null, needsReconnect: true, reason: err.reason, message: err.message };
    }
    throw err;
  }
  if (!connection?.token) return { connected: false, email: null };

  try {
    const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!res.ok) return { connected: false, email: null };
    const data = await driveJson(res);
    return { connected: true, email: data.user?.emailAddress || connection.email };
  } catch (error) {
    return { connected: false, email: null, error: error.message };
  }
}
