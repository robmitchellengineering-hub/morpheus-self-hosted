// Command Deck's own Google connection (Gmail + Calendar + Drive backup +
// Docs) — deliberately separate from lib/googleDrive.js's connection (that
// one is scoped to drive.file for unrelated Project file storage, Feature
// Backlog #12). Mirrors its shape exactly: per-user row with encrypted
// tokens, silent refresh near expiry, raw-fetch API helpers, no SDK.
import { prisma } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars/primary';

// Shared Drive folder name for everything Command Deck mirrors into the
// user's own Drive — the full-data backup (backupDeckToDrive.js) and
// Jarvis's long-term memory (lib/deckMemory.js) both live here, one place
// to look rather than scattered across separate folders.
export const DECK_BACKUP_FOLDER_NAME = 'Command Deck Backup';

// Tags every Calendar event syncMurbahBooking.js creates so
// listMurbahCalendarEvents.js can list back exactly (and only) those events
// server-side via Calendar's privateExtendedProperty filter — never the
// rest of Rob's actual calendar.
export const MURBAH_CALENDAR_EXTENDED_PROPERTIES = { private: { morpheusDeckMurbah: '1' } };
export const MURBAH_CALENDAR_QUERY = 'morpheusDeckMurbah=1';
const DOCS_API = 'https://docs.googleapis.com/v1/documents';

// ── Per-user connection ──────────────────────────────────────────────────

export async function getDeckGoogleConnection(userId) {
  const row = await prisma.deckGoogleConnection.findUnique({ where: { created_by_id: userId } });
  if (!row) return null;

  if (row.expires_at && row.expires_at.getTime() < Date.now() + 5 * 60 * 1000) {
    const refreshed = await tryRefreshDeckGoogleToken(row);
    if (refreshed) return refreshed;
  }

  const token = decrypt(row.access_token);
  return { email: row.google_email, token };
}

async function tryRefreshDeckGoogleToken(row) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return null;
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
      console.log(`Deck Google token refresh failed for connection ${row.id}: ${data.error_description || data.error || 'no access_token in response'}`);
      return null;
    }
    await prisma.deckGoogleConnection.update({
      where: { id: row.id },
      data: {
        access_token: encrypt(data.access_token),
        expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
        refresh_token: data.refresh_token ? encrypt(data.refresh_token) : row.refresh_token,
      },
    });
    return { email: row.google_email, token: data.access_token };
  } catch (err) {
    console.log(`Deck Google token refresh error for connection ${row.id}: ${err.message}`);
    return null;
  }
}

// Returns { email, token } for a user, or throws a friendly error.
export async function getDeckGoogleToken(userId) {
  const connection = await getDeckGoogleConnection(userId);
  if (!connection?.token) {
    throw Object.assign(
      new Error('Google not connected — connect it in Command Deck Settings first.'),
      { status: 400 },
    );
  }
  return connection;
}

async function apiJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _error: text }; }
}

// ── Gmail (raw fetch, no SDK) ────────────────────────────────────────────

// Lists recent inbox messages (id + threadId only — callers fetch full
// content per message via getGmailMessage). 2026-09-17 (Rob: a real inquiry
// — "a guy about dry hire" — never showed up once the inbox backlog grew):
// syncDeckGmailInbox.js used to call this with a fixed maxResults and no way
// to see further back, so once more than maxResults newer primary-category
// messages piled up, older never-classified mail fell permanently outside
// the window. Now returns nextPageToken so the caller can page back through
// backlog instead of only ever seeing "the newest N".
export async function listGmailMessages(token, { maxResults = 20, query = 'in:inbox', pageToken } = {}) {
  const params = new URLSearchParams({ maxResults: String(maxResults), q: query });
  if (pageToken) params.set('pageToken', pageToken);
  const res = await fetch(`${GMAIL_API}/messages?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await apiJson(res);
  if (!res.ok) throw new Error(`Gmail list failed: ${data.error?.message || data._error || res.status}`);
  return { messages: data.messages || [], nextPageToken: data.nextPageToken || null };
}

function decodeBase64Url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Returns { id, from, fromEmail, subject, snippet, body, date }, pulling
// the plain-text part (or falling back to the snippet) out of Gmail's
// nested MIME payload structure.
export async function getGmailMessage(token, id) {
  const res = await fetch(`${GMAIL_API}/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await apiJson(res);
  if (!res.ok) throw new Error(`Gmail get failed: ${data.error?.message || data._error || res.status}`);

  const headers = data.payload?.headers || [];
  const header = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  const fromHeader = header('From');
  const fromEmailMatch = fromHeader.match(/<(.+?)>/);
  const fromEmail = fromEmailMatch ? fromEmailMatch[1] : fromHeader;
  const fromName = fromHeader.replace(/<.+?>/, '').replace(/"/g, '').trim() || fromEmail;

  let body = '';
  const findPlainPart = (part) => {
    if (!part) return null;
    if (part.mimeType === 'text/plain' && part.body?.data) return part.body.data;
    for (const sub of part.parts || []) {
      const found = findPlainPart(sub);
      if (found) return found;
    }
    return null;
  };
  const plainData = findPlainPart(data.payload);
  if (plainData) body = decodeBase64Url(plainData);
  else if (data.payload?.body?.data) body = decodeBase64Url(data.payload.body.data);
  else body = data.snippet || '';

  return { id: data.id, threadId: data.threadId, from: fromName, fromEmail, subject: header('Subject'), snippet: data.snippet, body, date: header('Date') };
}

// Sends a reply in an existing thread (or a fresh message if threadId/inReplyTo omitted).
export async function sendGmailMessage(token, { to, subject, body, threadId, inReplyToMessageId }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (inReplyToMessageId) {
    lines.push(`In-Reply-To: <${inReplyToMessageId}>`, `References: <${inReplyToMessageId}>`);
  }
  const raw = Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}`)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, threadId }),
  });
  const data = await apiJson(res);
  if (!res.ok) throw new Error(`Gmail send failed: ${data.error?.message || data._error || res.status}`);
  return data;
}

// ── Calendar (raw fetch, no SDK) ─────────────────────────────────────────

// privateExtendedProperty filters server-side to events carrying a given
// extendedProperties.private key=value — used to list back only events this
// integration created (see MURBAH_CALENDAR_TAG below), never the rest of
// Rob's actual calendar.
export async function listCalendarEvents(token, { timeMin, maxResults = 20, privateExtendedProperty } = {}) {
  const params = new URLSearchParams({
    timeMin: timeMin || new Date().toISOString(),
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  });
  if (privateExtendedProperty) params.append('privateExtendedProperty', privateExtendedProperty);
  const res = await fetch(`${CALENDAR_API}/events?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await apiJson(res);
  if (!res.ok) throw new Error(`Calendar list failed: ${data.error?.message || data._error || res.status}`);
  return data.items || [];
}

export async function insertCalendarEvent(token, { summary, description, start, end, extendedProperties }) {
  const res = await fetch(`${CALENDAR_API}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary, description, start, end, extendedProperties }),
  });
  const data = await apiJson(res);
  if (!res.ok) throw new Error(`Calendar insert failed: ${data.error?.message || data._error || res.status}`);
  return data;
}

export async function updateCalendarEvent(token, eventId, { summary, description, start, end }) {
  const res = await fetch(`${CALENDAR_API}/events/${eventId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary, description, start, end }),
  });
  const data = await apiJson(res);
  if (!res.ok) throw new Error(`Calendar update failed: ${data.error?.message || data._error || res.status}`);
  return data;
}

// ── Docs (raw fetch, no SDK) ──────────────────────────────────────────────
// A small markdown-ish → Docs batchUpdate converter: headings, bold, bullet
// lists, and plain paragraphs — not full CommonMark, just enough for
// Jarvis-drafted documents.

export async function createGoogleDoc(token, title) {
  const res = await fetch(DOCS_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await apiJson(res);
  if (!res.ok) throw new Error(`Doc create failed: ${data.error?.message || data._error || res.status}`);
  return data;
}

export async function batchUpdateGoogleDoc(token, documentId, requests) {
  const res = await fetch(`${DOCS_API}/${documentId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  const data = await apiJson(res);
  if (!res.ok) throw new Error(`Doc update failed: ${data.error?.message || data._error || res.status}`);
  return data;
}
