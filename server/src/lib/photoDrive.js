// Pure helpers for the photo widget on the Alice Stats page.
//
// Dependency-free on purpose: scripts/verify-photo-drive.mjs imports this
// module in CI's no-install guards job, so nothing here may reach for prisma,
// fetch or a Drive client. The handler that talks to Drive lives in
// functions/photoDrive.js and is deliberately thin, so the parts that decide
// what is a valid folder, a valid photo and a truthful error message are all
// testable without a Google account.

/**
 * Largest photo we accept, in bytes.
 *
 * The real ceiling is the API's own body parser: express.json() is configured
 * at 15mb (server/src/index.js). The browser sends the image base64-encoded,
 * which inflates it by ~4/3, so an 8MB photo arrives at ~10.7MB and leaves
 * headroom for the rest of the payload. Raising this without also raising the
 * parser limit would produce a confusing 413 instead of a clear message.
 */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** Image types a browser can preview and Drive will store happily. */
export const ALLOWED_PHOTO_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
];

/**
 * A Drive folder id: 10+ chars of [A-Za-z0-9_-].
 *
 * Deliberately loose about the exact length or alphabet — Google has changed
 * both — and deliberately not loose about the shape, so a whole URL or a
 * sentence is rejected rather than sent to Drive as an id.
 */
const FOLDER_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

/** Namespaced key inside UserSettings.connections (an existing JSON column). */
export const CONNECTIONS_KEY = 'photoDriveFolderId';

/** The folder we offer to create when the user has not chosen one. */
export const DEFAULT_FOLDER_NAME = 'Morpheus Photos';

/**
 * Where a Google token may come from, **in the order we look**.
 *
 * Rob, 2026-09-22: "The google credentials should come from the google connected
 * from the user." Two per-user Google connections exist here — the Command
 * Deck's (`deckGoogleConnection`: Gmail, Calendar, Docs, email, and
 * `drive.file`) and the storage one (`googleDriveConnection`: `drive.file
 * email`). Both can write to Drive, so **whichever the user already granted is
 * the right one**: asking someone who has already connected Google for the Deck
 * to connect it again for a photo is the wrong default.
 *
 * Deck first because it is the broader connection and carries drive.file; the
 * storage connection is the fallback. A third Google consent screen is never the
 * answer — add a source here instead.
 */
export const GOOGLE_SOURCES = [
  { id: 'deck', label: 'your Command Deck Google account' },
  { id: 'drive', label: 'your connected Google Drive account' },
];

/**
 * Choose the token to use from the connections the user actually has, or null
 * when they have neither — the only case that should prompt for consent.
 *
 * Pure on purpose: the fallback order is a rule, and a rule the guard can drive
 * with plain objects is a rule that cannot quietly become "the Drive connection
 * is required" again. Each candidate is the shape both resolvers return,
 * `{ email, token }`, or null.
 */
export function chooseGoogleSource({ deck = null, drive = null } = {}) {
  const candidates = { deck, drive };
  for (const source of GOOGLE_SOURCES) {
    const found = candidates[source.id];
    if (found?.token) {
      return { source: source.id, label: source.label, email: found.email || null, token: found.token };
    }
  }
  return null;
}

/** Whether the user has any Google connection at all. */
export function hasAnyGoogleSource(connections = {}) {
  return chooseGoogleSource(connections) !== null;
}

/**
 * Turn whatever the operator pasted into a folder id, or null.
 *
 * Accepts the forms Google's UI actually hands people:
 *   https://drive.google.com/drive/folders/<id>
 *   https://drive.google.com/drive/u/1/folders/<id>?usp=sharing
 *   https://drive.google.com/open?id=<id>
 *   <id>                      (pasted straight from a URL bar or a share dialog)
 *
 * Returns null for anything else — including a folder NAME, which cannot be
 * resolved by name here and must not be guessed at.
 */
export function folderIdFromInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  // A bare id.
  if (FOLDER_ID_RE.test(s)) return s;

  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)drive\.google\.com$/i.test(url.hostname)) return null;

  // /drive/folders/<id>, /drive/u/1/folders/<id>
  const path = url.pathname.split('/').filter(Boolean);
  const at = path.indexOf('folders');
  if (at !== -1 && path[at + 1] && FOLDER_ID_RE.test(path[at + 1])) return path[at + 1];

  // /open?id=<id> and friends.
  const q = url.searchParams.get('id');
  if (q && FOLDER_ID_RE.test(q)) return q;

  return null;
}

/** The canonical link to show a user for a folder or file id. */
export function driveFolderLink(folderId) {
  const id = String(folderId ?? '').trim();
  return FOLDER_ID_RE.test(id) ? `https://drive.google.com/drive/folders/${id}` : '';
}

export function driveFileLink(fileId) {
  const id = String(fileId ?? '').trim();
  return FOLDER_ID_RE.test(id) ? `https://drive.google.com/file/d/${id}/view` : '';
}

/** Extension for a mime type, without the dot. jpeg → jpg. */
export function extensionForMime(mime) {
  const m = String(mime ?? '').toLowerCase().split(';')[0].trim();
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
  };
  return map[m] ?? '';
}

/**
 * A timestamped filename, so two photos taken seconds apart never collide and
 * the sort order in Drive matches the order they were taken.
 *
 * The original name is only used for its extension, and only when the mime
 * type did not already tell us: a name from a camera roll ("IMG_4021.HEIC") is
 * not worth preserving, and a name from a hostile client is not worth trusting.
 */
export function photoFilename(originalName, mime, now = new Date()) {
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[:]/g, '-');
  let ext = extensionForMime(mime);
  if (!ext) {
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(String(originalName ?? ''));
    ext = m ? m[1].toLowerCase() : 'jpg';
  }
  return `photo-${stamp}.${ext}`;
}

/**
 * Whether we will accept this photo, and why not when we will not.
 *
 * Returns { ok, reason } rather than throwing: the widget shows the reason
 * verbatim, and a thrown error here would be swallowed into a generic failure
 * at the call site.
 */
export function validatePhoto({ size, mime } = {}) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, reason: 'That file looks empty — pick a photo and try again.' };
  }
  if (bytes > MAX_PHOTO_BYTES) {
    const mb = (n) => Math.round((n / (1024 * 1024)) * 10) / 10;
    return {
      ok: false,
      reason: `That photo is ${mb(bytes)}MB; the limit is ${mb(MAX_PHOTO_BYTES)}MB. Take a smaller one, or resize it first.`,
    };
  }
  const type = String(mime ?? '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_PHOTO_MIME.includes(type)) {
    return {
      ok: false,
      reason: `${type || 'That file type'} is not an image we can send. Use a JPEG, PNG, WebP, GIF or HEIC.`,
    };
  }
  return { ok: true, reason: '' };
}

/**
 * Classify a Drive API failure.
 *
 * The point of this function is requirement 4: a scope problem and a
 * missing folder must not look the same, because the fix is different —
 * reconnect Google vs. pick another folder. Google's own messages are kept
 * alongside our sentence for the operator who wants the raw reason.
 */
export function classifyDriveError(status, message = '') {
  const s = Number(status);
  if (s === 401) {
    return {
      kind: 'auth',
      message: 'Google rejected the saved credentials. Reconnect Google Drive, then try again.',
    };
  }
  if (s === 403) {
    return {
      kind: 'scope',
      message:
        'Google refused the write. This connection is scoped to files this app created '
        + '(drive.file), so it can only save into a folder Morpheus made — create one below, '
        + 'or pick a folder that was created here.',
    };
  }
  if (s === 404) {
    return {
      kind: 'not-found',
      message: 'That Drive folder no longer exists, or it is not visible to this connection. Paste its link again or create a new folder.',
    };
  }
  if (s === 429) {
    return { kind: 'rate', message: 'Google is rate-limiting this account. Wait a minute and try again.' };
  }
  if (s >= 500) {
    return { kind: 'upstream', message: 'Drive had a server error. Nothing was saved — try again shortly.' };
  }
  return { kind: 'unknown', message: `Drive refused the request (${s || 'no status'}). ${String(message).slice(0, 200)}`.trim() };
}
