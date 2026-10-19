// User-Choice Cloud Storage (Feature Backlog #12), Phase 1. Mirrors
// lib/github.js's shape exactly: a per-user connection row (encrypted
// tokens, silent refresh near expiry) plus a set of raw-fetch API helpers.
// No `googleapis` SDK — it isn't a dependency anywhere in this codebase,
// and every existing Google/GitHub API call here is hand-rolled fetch; see
// routes/connections.routes.js for why this connection is its own OAuth
// flow rather than piggybacked on Google sign-in.
import { prisma } from '../db.js';
import { classifyRefreshFailure, reconnectMessage } from './googleReconnect.js';
import { decrypt, encrypt } from '../crypto.js';
import { logUsage } from './projectUtils.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

// ── Per-user connection ──────────────────────────────────────────────────

// Returns { email, token, accessToken } for the given user's connected
// Drive account, or null if they haven't connected one. Silently refreshes
// the access token when it's within 5 minutes of expiring, mirroring
// getGithubConnection's same-shaped logic.
export async function getGoogleDriveConnection(userId) {
  const row = await prisma.googleDriveConnection.findUnique({ where: { created_by_id: userId } });
  if (!row) return null;

  if (row.expires_at && row.expires_at.getTime() < Date.now() + 5 * 60 * 1000) {
    const refreshed = await tryRefreshGoogleDriveToken(row);
    if (refreshed.ok) {
      return { email: row.drive_email, token: refreshed.token, accessToken: refreshed.token };
    }
    // 2026-09-28. This used to fall through with the token it had just failed to renew, on the
    // theory that "the caller's own Drive API call will surface a clear error" — it surfaced
    // Google's OAuth text ("Request had invalid authentication credentials...") in a shop tool,
    // which names no cause and no action. A token known to be expired is a failure to report,
    // with the reason and the way out, not a credential to try with.
    throw Object.assign(new Error(reconnectMessage(refreshed.reason, 'Morpheus Settings → Google Drive')), {
      status: 400,
      code: 'GOOGLE_RECONNECT_REQUIRED',
      reason: refreshed.reason,
    });
  }

  const token = decrypt(row.access_token);
  return { email: row.drive_email, token, accessToken: token };
}

// Refreshes, or says WHY it could not: a revoked refresh token, a server missing its client
// credentials, and a dropped connection used to be the same `null`.
async function tryRefreshGoogleDriveToken(row) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return { ok: false, reason: 'not_configured' };
  }
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: decrypt(row.refresh_token),
      }),
    });
    const data = await res.json();
    if (!data.access_token) {
      const reason = classifyRefreshFailure(data);
      console.warn(`[googleDrive] refresh refused for connection ${row.id}: ${reason} — ${data.error_description || data.error || 'no access_token in response'}`);
      return { ok: false, reason };
    }
    await prisma.googleDriveConnection.update({
      where: { id: row.id },
      data: {
        access_token: encrypt(data.access_token),
        expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
        // Google only re-issues a refresh_token when it feels like it (rare
        // on a plain refresh grant) — keep the existing one unless a new
        // one actually comes back.
        refresh_token: data.refresh_token ? encrypt(data.refresh_token) : row.refresh_token,
      },
    });
    return { ok: true, token: data.access_token };
  } catch (err) {
    console.warn(`[googleDrive] refresh request failed for connection ${row.id}: ${err.message}`);
    return { ok: false, reason: 'network' };
  }
}

// Returns the Drive access token for a user, or throws a friendly error.
export async function getGoogleDriveToken(userId) {
  const connection = await getGoogleDriveConnection(userId);
  if (!connection?.token) {
    throw Object.assign(
      new Error('Google Drive not connected — connect it in Settings before switching a project to Drive storage.'),
      { status: 400 },
    );
  }
  return connection.token;
}

// ── Drive API v3 (raw fetch, no SDK) ─────────────────────────────────────

function driveHeadersJson(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export async function driveJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _error: text }; }
}

// Creates a folder (optionally inside parentId) and returns its Drive file id.
export async function createDriveFolder(token, name, parentId) {
  const res = await fetch(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: driveHeadersJson(token),
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    }),
  });
  const data = await driveJson(res);
  if (!data.id) throw new Error(`Failed to create Drive folder "${name}": ${data._error || data.error?.message || 'unknown error'}`);
  return data.id;
}

// Lists the immediate (non-trashed) children of a folder — id, name,
// modifiedTime, md5Checksum (used exactly like a git blob sha for
// incremental diffing in pullProjectFromDrive.js).
export async function listDriveFolderFiles(token, folderId) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,modifiedTime,md5Checksum)',
    pageSize: '1000',
  });
  const res = await fetch(`${DRIVE_API}/files?${params}`, { headers: driveHeadersJson(token) });
  const data = await driveJson(res);
  if (!Array.isArray(data.files)) throw new Error(`Failed to list Drive folder: ${data._error || data.error?.message || 'unknown error'}`);
  return data.files;
}

export async function getDriveFileContent(token, fileId) {
  const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive file fetch failed: HTTP ${res.status}`);
  return res.text();
}

// Metadata for one file or folder. Used to verify a folder id the operator
// pasted actually resolves, rather than trusting a string that looks like one.
// Throws with `.status` so a caller can tell 403 (this connection cannot see
// it) from 404 (no such id) — those need different words and different fixes.
export async function getDriveFileMeta(token, fileId) {
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await driveJson(res);
  if (!res.ok || !data.id) {
    const message = data._error || data.error?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Could not read that Drive item: ${message}`), {
      status: res.status,
      driveMessage: message,
    });
  }
  return data;
}

// Creates a new file with content in one call via a multipart/related
// upload (Drive's documented way to set metadata + content together
// without a client SDK). Returns { id, modifiedTime }.
export async function createDriveFile(token, { name, parentId, content, mimeType = 'text/plain' }) {
  const boundary = 'morpheus-drive-boundary-314159265358979';
  const metadata = { name, parents: parentId ? [parentId] : undefined, mimeType };
  const head =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  // Binary-safe. A photo arrives as a Buffer and must not pass through string
  // concatenation, which re-encodes every non-UTF8 byte and uploads a corrupt
  // image that Drive happily accepts (it stores whatever bytes it is given).
  // The text path — project file pushes — keeps the exact expression it has
  // always used, so nothing about existing uploads changes.
  const isBinary = Buffer.isBuffer(content) || content instanceof Uint8Array;
  const body = isBinary
    ? Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(content), Buffer.from(`\r\n--${boundary}--`, 'utf8')])
    : `${head}${content}\r\n--${boundary}--`;
  const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const data = await driveJson(res);
  if (!data.id) {
    const message = data._error || data.error?.message || 'unknown error';
    // Carry the HTTP status. Without it a caller cannot tell "this connection
    // cannot write here" (403) from "that folder does not exist" (404), and
    // those need different words and different fixes.
    throw Object.assign(new Error(`Failed to create Drive file "${name}": ${message}`), {
      status: res.status,
      driveMessage: message,
    });
  }
  return data;
}

// Replaces an existing file's content in place (name/parent unchanged).
// Returns { id, modifiedTime }.
export async function updateDriveFileContent(token, fileId, content, mimeType = 'text/plain') {
  const res = await fetch(`${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=media&fields=id,modifiedTime`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
    body: content,
  });
  const data = await driveJson(res);
  if (!data.id) throw new Error(`Failed to update Drive file ${fileId}: ${data._error || data.error?.message || 'unknown error'}`);
  return data;
}

// ── Push ─────────────────────────────────────────────────────────────────
// Shared core used by both functions/pushProjectToDrive.js (the HTTP
// endpoint) and functions/setProjectStorageMode.js (which triggers an
// initial push the moment a project switches to "drive" mode) — kept here
// rather than one function file importing another, matching how
// applyFileOperations lives in projectUtils.js rather than in any one
// endpoint that happens to call it first.
export async function pushProjectFilesToDrive(user, project) {
  const token = await getGoogleDriveToken(user.id);

  let folderId = project.drive_folder_id;
  if (!folderId) {
    folderId = await createDriveFolder(token, `Morpheus — ${project.name}`);
    await prisma.project.update({ where: { id: project.id }, data: { drive_folder_id: folderId } });
  }

  const files = await prisma.projectFile.findMany({ where: { project_id: project.id } });

  // Drive's own listing is the only reliable way to know a path's current
  // file id without trusting a possibly-stale local drive_file_id (e.g. if
  // a prior push partially failed) — same defensive-reread principle as
  // pullProjectFromDrive.js's diff.
  const existingByName = new Map((await listDriveFolderFiles(token, folderId)).map((f) => [f.name, f]));

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const file of files) {
    // Drive has no concept of subdirectories in a flat file list the way a
    // filesystem does — encode the path's slashes into the Drive filename
    // itself so pullProjectFromDrive.js can decode it back losslessly,
    // rather than standing up a real nested-folder tree for Phase 1.
    const driveName = file.path.replace(/\//g, '⁄'); // U+2044 FRACTION SLASH — visually a slash, never appears in a real path
    try {
      const existing = existingByName.get(driveName);
      let result;
      if (existing) {
        result = await updateDriveFileContent(token, existing.id, file.content);
        updated++;
      } else {
        result = await createDriveFile(token, { name: driveName, parentId: folderId, content: file.content });
        created++;
      }
      await prisma.projectFile.update({
        where: { id: file.id },
        data: { drive_file_id: result.id, drive_modified_time: new Date(result.modifiedTime) },
      });
    } catch (err) {
      console.error(`[pushProjectToDrive] failed to push ${file.path}:`, err.message);
      failed++;
    }
  }

  await logUsage(user.id, 'project_push_to_drive', project.id, project.name, { fileCount: files.length, created, updated, failed });

  return { projectId: project.id, driveFolderId: folderId, totalFiles: files.length, created, updated, failed };
}
