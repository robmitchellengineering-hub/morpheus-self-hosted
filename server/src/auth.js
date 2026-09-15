// Auth: JWT bearer tokens + bcrypt password hashing.
// Replaces Base44 Auth (email/password + Google OAuth + OTP email verify).
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { prisma } from './db.js';
import { WIDGET_TOKEN_PREFIX, resolveWidgetToken } from './lib/widgetToken.js';
import { DEVICE_TOKEN_PREFIX, resolveDeviceToken } from './lib/deviceToken.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function issueToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.cookies?.morpheus_token) return req.cookies.morpheus_token;
  // Popup/redirect-based OAuth flows (GitHub connect, Google login) can't
  // set a custom Authorization header on a top-level navigation — they pass
  // the bearer token as a query param instead. Safe here because these are
  // GET routes that only ever redirect onward; nothing sensitive is echoed.
  if (req.query?.token) return req.query.token;
  return null;
}

// Attaches req.user when a valid token is present; does not reject otherwise.
// A `wgt_` embeddable-widget token resolves to its owner + attaches req.widget
// ({ projectId, scopes, tokenId }); a `dvc_` Morpheus Connect device token
// (see lib/deviceToken.js) resolves to whichever end user approved it +
// attaches req.device ({ scopes, tokenId }) — no projectId, it's personal,
// not tied to any one project. The functions router narrows what either kind
// of request may then do.
export async function optionalAuth(req, _res, next) {
  const token = extractToken(req);
  if (!token) return next();
  if (token.startsWith(WIDGET_TOKEN_PREFIX)) {
    try {
      const w = await resolveWidgetToken(token);
      if (w) { req.user = w.user; req.widget = { projectId: w.projectId, scopes: w.scopes, tokenId: w.tokenId }; }
    } catch { /* ignore — proceeds unauthenticated */ }
    return next();
  }
  if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
    try {
      const d = await resolveDeviceToken(token);
      if (d) { req.user = d.user; req.device = { scopes: d.scopes, tokenId: d.tokenId }; }
    } catch { /* ignore — proceeds unauthenticated */ }
    return next();
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (user) req.user = user;
  } catch {
    // ignore invalid/expired token — request proceeds unauthenticated
  }
  next();
}

// Rejects with 401 when no valid user is attached.
export async function requireAuth(req, res, next) {
  await optionalAuth(req, res, () => {});
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// A `wgt_` widget token or a `dvc_` device token resolves to its
// owner/approver's full req.user (see optionalAuth above), so a route that
// only checks requireAuth — or even requireAdmin, since that person might
// really be an admin — would otherwise be fully reachable through it: every
// project's files, account settings, GitHub connections, admin controls,
// all of it, when the token was only ever supposed to grant one project (or,
// for a device token, one narrow capability) + a fixed set of functions. The
// one route that's actually meant to accept either kind of scoped token is
// functions.routes.js, which does its own per-function narrowing
// (widgetMayCall/deviceMayCall + forced projectId for widgets) — every OTHER
// authenticated router mounts this right after requireAuth so a scoped token
// 403s there instead of inheriting the full account.
export function blockWidget(req, res, next) {
  if (req.widget || req.device) return res.status(403).json({ error: 'This endpoint is not available to a scoped token.' });
  next();
}

export function publicUser(user) {
  if (!user) return null;
  const { password_hash, otp_code, ...rest } = user;
  // credit_balance is a Prisma Decimal (server/src/lib/billing.js, Step 3) —
  // its default JSON serialization is a string, not a number. Coerce here so
  // every API response carries a proper JSON number regardless of call site.
  if (rest.credit_balance != null) rest.credit_balance = Number(rest.credit_balance);
  return rest;
}
