// licenceRegister.js — the rules of the operator's licence register, as units that can be tested without a database.
//
// WHY THIS FILE EXISTS. The register is the one screen that can see every account's licence, so the rules that keep it
// honest (who may look, what may be returned, what "active" means) must be provable in the guards job, which installs
// nothing and cannot import Prisma. Every decision here is pure: the handler becomes a query, and the rules get a test.
//
// THE DISCLOSURE RULE (hazard H16). An admin read that returns "everything" is how another account's private data leaks
// into a view. This register needs an email and nothing else: `ownerView` is an allow-list, not a spread, so a column
// added to `User` tomorrow cannot appear on this screen by accident.
export const STATE = Object.freeze({ ACTIVE: "active", EXPIRED: "expired", REVOKED: "revoked" });
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

/** Active / expired / revoked, derived from the row and nothing else. A row with no parsable expiry is not active. */
export function stateOf(row, now = Date.now()) {
  if (row?.revoked_at) return STATE.REVOKED;
  const exp = row?.expires_at ? new Date(row.expires_at).getTime() : NaN;
  if (!Number.isFinite(exp)) return STATE.EXPIRED;
  return exp <= now ? STATE.EXPIRED : STATE.ACTIVE;
}

/**
 * Throws with an HTTP status when the caller may not read or revoke another account's licence.
 * The router enforces this too (ADMIN_FUNCTIONS); this is defence in depth, because a route table is a
 * configuration and a handler is the thing that runs.
 */
export function assertAdmin(user) {
  if (!user?.id) throw Object.assign(new Error("Sign in to see the licence register."), { status: 401 });
  if (user.role !== "admin") throw Object.assign(new Error("The licence register is admin-only."), { status: 403 });
  return true;
}

/** The query a page may ask for, clamped. An unknown state is dropped rather than silently returning everything. */
export function normaliseQuery(body = {}) {
  const raw = body ?? {};
  const q = String(raw.q ?? "").trim().slice(0, 120);
  const state = [STATE.ACTIVE, STATE.EXPIRED, STATE.REVOKED].includes(raw.state) ? raw.state : null;
  const limit = Math.min(Math.max(Number.parseInt(raw.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number.parseInt(raw.offset, 10) || 0, 0);
  return { q, state, limit, offset };
}

/** Prisma `where` for a state. Built here so the handler has no conditional of its own to get wrong. */
export function whereFor(state, now = new Date()) {
  if (state === STATE.REVOKED) return { revoked_at: { not: null } };
  if (state === STATE.ACTIVE) return { revoked_at: null, expires_at: { gt: now } };
  if (state === STATE.EXPIRED) return { revoked_at: null, expires_at: { lte: now } };
  return {};
}

/** Free-text search across the two things an operator actually has: the jti and the account's email. */
export function searchFor(q) {
  if (!q) return {};
  return {
    OR: [
      { jti: { contains: q, mode: "insensitive" } },
      { user: { email: { contains: q, mode: "insensitive" } } },
    ],
  };
}

/** The ONLY fields a register row may carry about its owner. Allow-list: no hashes, no OAuth ids, no OTP. */
export function ownerView(user) {
  if (!user) return null;
  return { id: user.id ?? null, email: user.email ?? null, name: user.full_name ?? null };
}

/** Counts for the summary line, from the rows the page already has. */
export function summarise(rows, now = Date.now()) {
  const counts = { [STATE.ACTIVE]: 0, [STATE.EXPIRED]: 0, [STATE.REVOKED]: 0 };
  for (const r of rows ?? []) counts[stateOf(r, now)]++;
  return { shown: rows?.length ?? 0, ...counts };
}

/** One register row, from a Prisma row. Pure, so the test can assert exactly what a browser receives. */
export function rowView(row, now = Date.now()) {
  return {
    jti: row.jti,
    plan: row.plan,
    seats: row.seats,
    kid: row.kid,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    note: row.note ?? null,
    state: stateOf(row, now),
    owner: ownerView(row.user),
  };
}
