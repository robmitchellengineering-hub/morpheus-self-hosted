// Upload a photo to the signed-in user's OWN Google Drive, from the Alice Stats
// page's photo widget.
//
// The privacy point is the feature: the photo goes to the user's Drive and
// nowhere else — no S3, no media-assets route, nothing in Morpheus storage.
// That is the product's "ownership, not rental" promise made concrete, and the
// widget says so in as many words.
//
// Reuses the existing per-user Drive connection (lib/googleDrive.js, scope
// `drive.file`) rather than standing up a second OAuth client. That scope has a
// consequence this handler must be honest about: drive.file can only see and
// write files THIS APP created, so a folder the user picked out of their own
// Drive will come back 403 — which is why the widget offers to create a folder
// and why 403 and 404 must never be reported as the same failure.
//
// Storage: the chosen folder id lives in UserSettings.connections — an existing
// JSON string column read elsewhere as plain JSON.parse (getBackendLogs.js).
// Deliberately NOT a new column: migrations here are hand-run SQL and a known
// hazard (H8).
import { prisma } from '../db.js';
import { createDriveFile, createDriveFolder, getDriveFileMeta, getGoogleDriveConnection } from '../lib/googleDrive.js';
import { getDeckGoogleConnection } from '../lib/deckGoogle.js';
import {
  CONNECTIONS_KEY, DEFAULT_FOLDER_NAME, chooseGoogleSource, classifyDriveError, driveFileLink,
  driveFolderLink, folderIdFromInput, photoFilename, validatePhoto,
} from '../lib/photoDrive.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ACTIONS = ['status', 'set_folder', 'create_folder', 'upload'];

/** The user's chosen folder id, or null. Mirrors getBackendLogs.js's reader. */
async function readFolderId(userId) {
  const row = await prisma.userSettings.findUnique({
    where: { created_by_id: userId },
    select: { connections: true },
  });
  if (!row?.connections) return null;
  try {
    return JSON.parse(row.connections)?.[CONNECTIONS_KEY] ?? null;
  } catch {
    return null;
  }
}

/** Write the folder id back, preserving every other key in that JSON blob. */
async function writeFolderId(userId, folderId) {
  const row = await prisma.userSettings.findUnique({
    where: { created_by_id: userId },
    select: { connections: true },
  });
  let all = {};
  try {
    all = row?.connections ? JSON.parse(row.connections) : {};
  } catch { all = {}; }
  all[CONNECTIONS_KEY] = folderId;
  const connections = JSON.stringify(all);
  await prisma.userSettings.upsert({
    where: { created_by_id: userId },
    create: { created_by_id: userId, connections },
    update: { connections },
  });
}

/** Drive failures become errors carrying the HTTP status and our own words. */
function driveFailure(err, source = null) {
  const { kind, message } = classifyDriveError(err?.status, err?.driveMessage || err?.message);
  // The Deck connection's scope list includes drive.file, but a connection made
  // before that was added would not have it — so a 403 on a Deck token has one
  // extra, specific fix worth naming rather than leaving as "reconnect".
  const hint = (kind === 'scope' && source === 'deck')
    ? ' If this is your Command Deck connection, reconnecting it there re-grants the Drive permission.'
    : '';
  return Object.assign(new Error(message + hint), { status: err?.status || 502, kind, source });
}

/**
 * The Google token to use for this user, from whichever Google connection they
 * already have — the Command Deck's first (it carries drive.file), the storage
 * connection second. Only a user with NEITHER is asked to connect anything.
 */
async function googleSource(userId) {
  const [deck, drive] = await Promise.all([
    getDeckGoogleConnection(userId).catch(() => null),
    getGoogleDriveConnection(userId).catch(() => null),
  ]);
  const chosen = chooseGoogleSource({ deck, drive });
  if (!chosen) {
    return {
      connected: false,
      message:
        'No Google account is connected to this login yet, so there is nowhere to put the photo. '
        + 'Connect Google once — in Settings → Google Drive, or in Command Deck — and this widget uses '
        + 'that same account. It never asks for a second one. The photo is never stored by Morpheus.',
      connectPath: '/settings',
    };
  }
  return { connected: true, ...chosen };
}

export default async function handler({ user, body }) {
  const action = body?.action;
  if (!ACTIONS.includes(action)) {
    throw Object.assign(new Error(`action must be one of ${ACTIONS.join(', ')}.`), { status: 400 });
  }

  const conn = await googleSource(user.id);

  // `status` answers even when Drive is not connected: that is the state the
  // widget needs to render its "connect this first" panel.
  if (!conn.connected) {
    if (action === 'status') return { connected: false, message: conn.message, connectPath: conn.connectPath };
    throw Object.assign(new Error(conn.message), { status: 400, kind: 'no-connection' });
  }

  const { token } = conn;

  if (action === 'status') {
    const folderId = await readFolderId(user.id);
    if (!folderId) {
      return {
        connected: true,
        email: conn.email,
        source: conn.source,
        sourceLabel: conn.label,
        folder: null,
        suggestedFolderName: DEFAULT_FOLDER_NAME,
        message: 'No folder chosen yet. Create one, or paste the link to a folder Morpheus made.',
      };
    }
    try {
      const meta = await getDriveFileMeta(token, folderId);
      if (meta.mimeType !== FOLDER_MIME) {
        return {
          connected: true,
          email: conn.email,
          source: conn.source,
          sourceLabel: conn.label,
          folder: null,
          staleFolderId: folderId,
          suggestedFolderName: DEFAULT_FOLDER_NAME,
          message: 'The saved Drive folder is not a folder any more. Pick another, or create one.',
        };
      }
      return {
        connected: true,
        email: conn.email,
        folder: { id: meta.id, name: meta.name, link: driveFolderLink(meta.id) },
        suggestedFolderName: DEFAULT_FOLDER_NAME,
      };
    } catch (err) {
      const { kind, message } = classifyDriveError(err?.status, err?.driveMessage || err?.message);
      return {
        connected: true,
        email: conn.email,
        folder: null,
        folderError: { kind, message },
        suggestedFolderName: DEFAULT_FOLDER_NAME,
        message,
      };
    }
  }

  if (action === 'set_folder') {
    const folderId = folderIdFromInput(body?.input);
    if (!folderId) {
      throw Object.assign(
        new Error('That does not look like a Drive folder link or id. Paste a link like https://drive.google.com/drive/folders/… , or create a folder instead.'),
        { status: 400 },
      );
    }
    let meta;
    try {
      meta = await getDriveFileMeta(token, folderId);
    } catch (err) {
      throw driveFailure(err, conn.source); // keeps 403-vs-404 intact for the widget
    }
    if (meta.mimeType !== FOLDER_MIME) {
      throw Object.assign(new Error('That link points at a file, not a folder. Give me a folder.'), { status: 400 });
    }
    await writeFolderId(user.id, meta.id);
    return { ok: true, folder: { id: meta.id, name: meta.name, link: driveFolderLink(meta.id) } };
  }

  if (action === 'create_folder') {
    const name = String(body?.name || DEFAULT_FOLDER_NAME).trim().slice(0, 80) || DEFAULT_FOLDER_NAME;
    let id;
    try {
      id = await createDriveFolder(token, name);
    } catch (err) {
      throw driveFailure(err, conn.source);
    }
    await writeFolderId(user.id, id);
    return { ok: true, folder: { id, name, link: driveFolderLink(id) } };
  }

  // upload
  const folderId = await readFolderId(user.id);
  if (!folderId) {
    throw Object.assign(new Error('No Drive folder set yet — create one or paste a folder link first.'), { status: 400 });
  }

  const base64 = String(body?.dataBase64 || '');
  const mimeType = String(body?.mimeType || '').toLowerCase().split(';')[0].trim();
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw Object.assign(new Error('That photo could not be decoded — try taking it again.'), { status: 400 });
  }

  // Size is checked on the DECODED bytes: the limit the operator cares about is
  // the photo, not its base64 overhead.
  const verdict = validatePhoto({ size: buffer.length, mime: mimeType });
  if (!verdict.ok) throw Object.assign(new Error(verdict.reason), { status: 400 });

  const name = photoFilename(body?.name, mimeType);
  let created;
  try {
    created = await createDriveFile(token, { name, parentId: folderId, content: buffer, mimeType });
  } catch (err) {
    throw driveFailure(err, conn.source);
  }

  let folderName = null;
  try {
    folderName = (await getDriveFileMeta(token, folderId)).name;
  } catch { /* the upload already succeeded; a missing folder name is not a failure */ }

  return {
    ok: true,
    file: { id: created.id, name, link: driveFileLink(created.id), mimeType, bytes: buffer.length },
    folder: { id: folderId, name: folderName, link: driveFolderLink(folderId) },
    storedBy: 'google-drive',
    email: conn.email,
  };
}
