// Command Deck's "Data vault" reachability check.
//
// `last_backup_at` only records that a backup SUCCEEDED at some point. It says
// nothing about whether the vault is reachable NOW — the Drive folder can be
// deleted or trashed, the grant revoked, or the refresh token stop working, and
// the card would keep showing a reassuring timestamp from weeks ago right up
// until the moment a restore is actually needed.
//
// So this live-probes Drive (the same discipline checkDeckGoogleConnection.js
// and checkGoogleDriveConnection.js already use) and reports what it actually
// found.
//
// Own-data rule (schema.prisma's Deck* comment / lib/deckGoogle.js): this reads
// the DECK's own connection and folder. It must never fall back to Morpheus's
// GoogleDriveConnection or login OAuth — the vault is the user's private Deck
// data, deliberately separate from the platform's own integration.
import { prisma } from '../db.js';
import { getDeckGoogleConnection, getDeckGoogleToken, DECK_BACKUP_FOLDER_NAME } from '../lib/deckGoogle.js';
import { listDriveFolderFiles } from '../lib/googleDrive.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const BACKUP_FILE_NAME = 'command-deck-backup.json';

// Days since the last successful backup, or null when there has never been one.
function ageDaysSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : null;
}

export default async function handler({ user }) {
  const base = {
    folderName: DECK_BACKUP_FOLDER_NAME,
    fileName: BACKUP_FILE_NAME,
  };

  const connection = await getDeckGoogleConnection(user.id);
  const row = await prisma.deckGoogleConnection.findUnique({
    where: { created_by_id: user.id },
    select: { last_backup_at: true, backup_folder_id: true },
  });
  const lastBackupAt = row?.last_backup_at?.toISOString() || null;

  if (!connection?.token) {
    return { ...base, reachable: false, reason: 'not-connected', lastBackupAt, ageDays: null };
  }
  if (!row?.backup_folder_id) {
    return { ...base, reachable: false, reason: 'never-backed-up', lastBackupAt, ageDays: null };
  }

  const folderId = row.backup_folder_id;

  try {
    const { token } = await getDeckGoogleToken(user.id);

    // Confirm the FOLDER still exists before trusting its listing. A listing
    // for a deleted folder's id comes back as an empty file list, not an error,
    // so "empty" and "gone" are indistinguishable from the listing alone —
    // and they mean very different things to someone about to rely on it.
    const folderRes = await fetch(`${DRIVE_API}/files/${folderId}?fields=id,name,trashed`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (folderRes.status === 404) {
      return { ...base, reachable: false, reason: 'folder-missing', lastBackupAt, folderId, ageDays: ageDaysSince(lastBackupAt) };
    }
    if (!folderRes.ok) {
      const detail = await folderRes.text().catch(() => '');
      return {
        ...base, reachable: false, reason: 'probe-failed', lastBackupAt, folderId,
        ageDays: ageDaysSince(lastBackupAt),
        error: `Drive returned ${folderRes.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      };
    }
    const folder = await folderRes.json();
    if (folder.trashed) {
      return { ...base, reachable: false, reason: 'folder-trashed', lastBackupAt, folderId, ageDays: ageDaysSince(lastBackupAt) };
    }

    const backup = (await listDriveFolderFiles(token, folderId)).find((f) => f.name === BACKUP_FILE_NAME);
    if (!backup) {
      return { ...base, reachable: true, reason: 'folder-empty', lastBackupAt, folderId, ageDays: ageDaysSince(lastBackupAt) };
    }

    return {
      ...base,
      reachable: true,
      reason: 'ok',
      lastBackupAt,
      folderId,
      backupModifiedAt: backup.modifiedTime || null,
      ageDays: ageDaysSince(lastBackupAt),
    };
  } catch (error) {
    // Refresh failure, revoked grant, network trouble — anything that stops the
    // vault being usable right now. Reported as unreachable rather than thrown:
    // "the vault is not reachable" is the answer, not an error state.
    return {
      ...base, reachable: false, reason: 'unreachable', lastBackupAt, folderId,
      ageDays: ageDaysSince(lastBackupAt), error: error.message,
    };
  }
}
