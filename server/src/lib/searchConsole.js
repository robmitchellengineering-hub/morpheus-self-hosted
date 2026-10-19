// Google Search Console — the account's own verified properties, read-only.
//
// Mirrors lib/googleDrive.js's shape deliberately: a per-user connection row
// (encrypted tokens, silent refresh near expiry) plus raw-fetch API helpers. No
// `googleapis` SDK — it is not a dependency anywhere in this codebase and every
// other Google/GitHub call here is hand-rolled fetch.
//
// The API surface was checked against Google's own reference before this was
// written (they are the `webmasters/v3` methods), because writing against an
// external API's shape from memory is hazard H10:
//
//   GET  /sites                                   list the user's properties
//   POST /sites/{siteUrl}/searchAnalytics/query   the performance data
//
// There is NO links/backlinks method — Google's reference lists only Search
// Analytics, Sitemaps, Sites and URL Inspection. So "who links to you" is not
// answerable from here, and the UI links out to Search Console's own Links
// report rather than implying a number we cannot fetch.
import { prisma } from '../db.js';
import { classifyRefreshFailure, reconnectMessage } from './googleReconnect.js';
import { decrypt, encrypt } from '../crypto.js';
import { describeGoogleError } from './searchConsoleInsights.js';

const GSC_API = 'https://www.googleapis.com/webmasters/v3';

// Read-only is enough: Morpheus reads performance data and never adds or removes
// a property. Asking for `webmasters` (full) would be a larger consent for
// nothing.
export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

// ── Per-user connection ──────────────────────────────────────────────────────

/**
 * The caller's Search Console connection, or null if they have not connected one.
 *
 * Silently refreshes an access token within 5 minutes of expiry, exactly as
 * getGoogleDriveConnection does.
 *
 * CORRECTED 2026-09-28: a failed refresh used to fall through with the possibly-stale token, on the
 * theory that Google's own error beats "a generic local one". It does not — the operator gets
 * "Request had invalid authentication credentials" with no cause and no action. It now throws the
 * reason and the way out (see lib/googleReconnect.js).
 */
export async function getSearchConsoleConnection(userId) {
  const row = await prisma.searchConsoleConnection.findUnique({ where: { created_by_id: userId } });
  if (!row) return null;

  if (row.expires_at && row.expires_at.getTime() < Date.now() + 5 * 60 * 1000) {
    const refreshed = await tryRefreshSearchConsoleToken(row);
    if (refreshed.ok) return { email: row.gsc_email, accessToken: refreshed.token, property: row.property || null };
    throw Object.assign(new Error(reconnectMessage(refreshed.reason, 'Morpheus Settings → Search Console')), {
      status: 400,
      code: 'GOOGLE_RECONNECT_REQUIRED',
      reason: refreshed.reason,
    });
  }

  return {
    email: row.gsc_email,
    accessToken: decrypt(row.access_token),
    property: row.property || null,
  };
}

async function tryRefreshSearchConsoleToken(row) {
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
      console.warn(`[searchConsole] refresh refused for connection ${row.id}: ${reason} — ${data.error_description || data.error || 'no access_token in response'}`);
      return { ok: false, reason };
    }
    await prisma.searchConsoleConnection.update({
      where: { id: row.id },
      data: {
        access_token: encrypt(data.access_token),
        expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
        // Google re-issues a refresh_token only sometimes; keep the existing one
        // when it does not, or the connection dies at the next expiry.
        ...(data.refresh_token ? { refresh_token: encrypt(data.refresh_token) } : {}),
      },
    });
    return { ok: true, token: data.access_token };
  } catch (err) {
    console.warn(`[searchConsole] refresh request failed for connection ${row.id}: ${err.message}`);
    return { ok: false, reason: 'network' };
  }
}

// ── Honest errors ────────────────────────────────────────────────────────────
// The classifier is pure and lives in searchConsoleInsights.js so CI's
// no-install guards job can assert it; this file reaches Prisma, so nothing in
// the guard may import from here (hazard H4/H12).

async function gscFetch(accessToken, path, init = {}) {
  const res = await fetch(`${GSC_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const described = describeGoogleError(res.status, body);
    throw Object.assign(new Error(described.message), { status: 502, code: described.code });
  }
  return body;
}

// ── API calls ────────────────────────────────────────────────────────────────

/**
 * The account's Search Console properties.
 *
 * `permissionLevel` matters and is passed through rather than filtered: a
 * property the account can only see as `siteUnverifiedUser` is not one it can
 * read performance for, and hiding that here would make the picker lie.
 */
export async function listProperties(accessToken) {
  const body = await gscFetch(accessToken, '/sites');
  return (body?.siteEntry || []).map((s) => ({
    siteUrl: s.siteUrl,
    permissionLevel: s.permissionLevel,
  }));
}

/**
 * Performance rows for a property.
 *
 * `dataState: 'all'` includes Google's fresh (still-settling) data, which is
 * what the Search Console UI shows by default — omitting it would make the last
 * few days look emptier here than in Google's own report and read as a bug.
 */
export async function querySearchAnalytics(accessToken, siteUrl, { startDate, endDate, dimensions = ['query'], rowLimit = 500 } = {}) {
  const body = await gscFetch(accessToken, `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: 'POST',
    body: JSON.stringify({ startDate, endDate, dimensions, rowLimit, dataState: 'all' }),
  });
  return {
    rows: body?.rows || [],
    responseAggregationType: body?.responseAggregationType || null,
  };
}

/** YYYY-MM-DD, `days` before today, in UTC. Search Console's own dates are PT. */
export function isoDaysAgo(days, from = new Date()) {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** The date range the UI offers, in the shape the API wants. */
export function dateRange(days, from = new Date()) {
  return { startDate: isoDaysAgo(days, from), endDate: isoDaysAgo(1, from) };
}
