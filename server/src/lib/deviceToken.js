// Morpheus Connect — device login for native/compiled apps (e.g. Construct's
// Wikidata Batch Uploader). A distributable .exe can't hold a per-user
// session and must never embed a static secret tied to whoever built it
// (anyone running the binary would then spend that person's credits, not
// their own). Device flow instead: the app requests a short code, the end
// user approves it in their own browser while logged into their own
// Morpheus account, the app polls until it gets back a DeviceToken —
// resolvable server-side to that end user, so every AI call made with it
// bills their own credits through the same invokeAI path every other call
// already goes through.
//
// Mirrors widgetToken.js's hash-at-rest/revocable token shape closely, with
// two real differences: a DeviceToken is personal (no project_id) rather
// than per-project, and getting one starts from a public, unauthenticated
// request (see routes/deviceAuth.routes.js) rather than an already-logged-in
// session — Morpheus itself is the authority here, unlike the existing
// GitHub Device Flow (connections.routes.js) where GitHub holds the pending
// device_code and Morpheus just relays to it. That's why the pending state
// below is real DB rows, not a signed JWT.
import crypto from 'node:crypto';
import { prisma } from '../db.js';

export const DEVICE_TOKEN_PREFIX = 'dvc_';
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

// The functions a device token is allowed to call. Deliberately its own,
// separate map from widgetToken.js's WIDGET_SCOPE_FUNCTIONS — chat/deploy/
// store are far too broad a surface to expose to an anonymous compiled
// binary that could end up on anyone's machine.
export const DEVICE_SCOPE_FUNCTIONS = {
  ai_action: ['runAiAction'],
};
const DEFAULT_SCOPES = ['ai_action'];

export function isMissingDeviceTable(err) {
  const m = err && typeof err.message === 'string' ? err.message : '';
  return err?.code === 'P2021' || err?.code === 'P2022'
    || /relation\s+"?(device_auth_requests|device_tokens)"?\s+does not exist/i.test(m)
    || /Cannot read properties of undefined \(reading '(find|findFirst|create|update|delete|updateMany)/i.test(m);
}

const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// Short, human-typeable code for the approval page (e.g. "WXYZ-1234") —
// distinct from device_code, which the app itself never shows anyone.
function generateUserCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to misread
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return out;
}

// Step 1 — the app starts a request. No auth: the caller has no Morpheus
// session yet. Returns the raw codes; device_code is long/opaque enough
// (32 random bytes) that showing it back unhashed is fine — same reasoning
// connections.routes.js already documents for GitHub's own device_code:
// single-use, short-lived, inert until a real human approves it.
export async function createPendingDeviceRequest({ clientLabel, scopes }) {
  const device_code = crypto.randomBytes(32).toString('hex');
  const user_code = generateUserCode();
  const clean = (Array.isArray(scopes) && scopes.length ? scopes : DEFAULT_SCOPES)
    .filter((s) => Object.prototype.hasOwnProperty.call(DEVICE_SCOPE_FUNCTIONS, s));
  const row = await prisma.deviceAuthRequest.create({
    data: {
      device_code,
      user_code,
      client_label: String(clientLabel || 'An app').slice(0, 80),
      scopes: (clean.length ? clean : DEFAULT_SCOPES).join(','),
      expires_at: new Date(Date.now() + PENDING_TTL_MS),
    },
  });
  return { device_code, user_code, expires_in: Math.round(PENDING_TTL_MS / 1000), client_label: row.client_label };
}

// Step 2 (repeated) — the app polls with device_code. No auth.
export async function pollDeviceRequest(device_code) {
  if (typeof device_code !== 'string' || !device_code) return { status: 'error' };
  const row = await prisma.deviceAuthRequest.findUnique({ where: { device_code } });
  if (!row) return { status: 'error' };
  if (row.expires_at < new Date() && row.status === 'pending') {
    await prisma.deviceAuthRequest.update({ where: { id: row.id }, data: { status: 'expired' } }).catch(() => {});
    return { status: 'expired' };
  }
  if (row.status === 'pending') return { status: 'pending' };
  if (row.status === 'denied') return { status: 'denied' };
  if (row.status === 'expired') return { status: 'expired' };
  if (row.status === 'approved') {
    // The plaintext token only ever exists here, transiently — set by
    // approveDeviceRequest, read and immediately cleared on the app's next
    // poll. If it's already gone (a retry, or the app polled twice), there's
    // nothing left to hand back; the app should have kept the first response.
    if (!row.pending_token) return { status: 'error', error: 'Token already retrieved. Start a new connection.' };
    await prisma.deviceAuthRequest.update({ where: { id: row.id }, data: { pending_token: null } });
    return { status: 'approved', token: row.pending_token };
  }
  return { status: 'error' };
}

// Step 3 — a real, logged-in Morpheus user approves the request from the
// /connect page. The plaintext token is deliberately NOT returned here —
// this call happens in the approving human's browser tab, which has no use
// for it; it's stashed as pending_token for the polling app (the actual
// intended holder) to pick up on its next poll, see pollDeviceRequest above.
export async function approveDeviceRequest(user_code, userId) {
  const row = await prisma.deviceAuthRequest.findUnique({ where: { user_code } });
  if (!row) throw Object.assign(new Error('This code is invalid or has already been used.'), { status: 404 });
  if (row.status !== 'pending') throw Object.assign(new Error(`This request is already ${row.status}.`), { status: 400 });
  if (row.expires_at < new Date()) {
    await prisma.deviceAuthRequest.update({ where: { id: row.id }, data: { status: 'expired' } });
    throw Object.assign(new Error('This code expired. Ask the app to generate a new one.'), { status: 400 });
  }

  const secret = DEVICE_TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
  const token = await prisma.deviceToken.create({
    data: {
      created_by_id: userId,
      label: row.client_label,
      token_prefix: secret.slice(0, DEVICE_TOKEN_PREFIX.length + 8),
      token_hash: hash(secret),
      scopes: row.scopes,
    },
  });
  await prisma.deviceAuthRequest.update({
    where: { id: row.id },
    data: { status: 'approved', approved_by_id: userId, issued_token_id: token.id, pending_token: secret },
  });
  return { client_label: row.client_label };
}

export async function denyDeviceRequest(user_code, userId) {
  const row = await prisma.deviceAuthRequest.findUnique({ where: { user_code } });
  if (!row || row.status !== 'pending') return { ok: true };
  await prisma.deviceAuthRequest.update({ where: { id: row.id }, data: { status: 'denied', approved_by_id: userId } });
  return { ok: true };
}

// For the /connect page: what to show before the human clicks Approve/Deny.
export async function getPendingDeviceRequest(user_code) {
  const row = await prisma.deviceAuthRequest.findUnique({ where: { user_code } });
  if (!row) return null;
  if (row.status === 'pending' && row.expires_at < new Date()) {
    await prisma.deviceAuthRequest.update({ where: { id: row.id }, data: { status: 'expired' } }).catch(() => {});
    return { client_label: row.client_label, status: 'expired' };
  }
  return { client_label: row.client_label, status: row.status, scopes: row.scopes.split(',') };
}

// Resolve a raw dvc_ token → { user, scopes, tokenId } or null. Bumps
// last_used_at (fire-and-forget). Called from auth.js's optionalAuth.
export async function resolveDeviceToken(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  try {
    const row = await prisma.deviceToken.findUnique({ where: { token_hash: hash(raw) } });
    if (!row || row.revoked) return null;
    const user = await prisma.user.findUnique({ where: { id: row.created_by_id } });
    if (!user) return null;
    prisma.deviceToken.update({ where: { id: row.id }, data: { last_used_at: new Date() } }).catch(() => {});
    return { user, scopes: row.scopes.split(','), tokenId: row.id };
  } catch (err) {
    if (isMissingDeviceTable(err)) return null;
    throw err;
  }
}

export async function listDeviceTokens(userId) {
  try {
    const rows = await prisma.deviceToken.findMany({
      where: { created_by_id: userId },
      orderBy: { created_date: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id, prefix: r.token_prefix, label: r.label,
      scopes: r.scopes.split(','), revoked: r.revoked,
      last_used_at: r.last_used_at, created_date: r.created_date,
    }));
  } catch (err) {
    if (isMissingDeviceTable(err)) return [];
    throw err;
  }
}

export async function revokeDeviceToken(tokenId, userId) {
  await prisma.deviceToken.updateMany({
    where: { id: tokenId, created_by_id: userId },
    data: { revoked: true },
  });
  return { revoked: true };
}

// Is `functionName` callable with these device scopes?
export function deviceMayCall(scopes, functionName) {
  return (scopes || []).some((s) => (DEVICE_SCOPE_FUNCTIONS[s] || []).includes(functionName));
}
