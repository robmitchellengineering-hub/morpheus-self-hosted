// licencePolicy.js — WHO may be issued a licence, as a unit you can test without a database.
//
// WHY THIS FILE EXISTS. The rule started inline in `issueLicence.js`, which was correct and untestable in
// the guards job: importing that handler pulls in Prisma, and the guards job deliberately installs nothing
// (`verify-guards-no-install.mjs` refuses any guard that reaches a package import — a good rule, because it
// is what keeps that job fast and immune to a flaky registry).
//
// So the authorisation rule moves here, where it has no dependencies at all, and the handler becomes a
// caller. The behaviour is identical; what changes is that it can be proven in the job with no node_modules.
//
// THE RULE, and why it is this narrow:
//   * no session            -> 401 (sign in)
//   * session, not an admin -> 403 (buy a plan; the purchase path issues it)
//   * admin                 -> allowed
//
// The payment path that actually sells licences is not wired, so the only door is an admin issuing for an
// account. When payment exists, the webhook calls the same handler and this predicate widens to
// "admin OR a verified payment reference" — one function, one place, and the guard already points at it.

export const ISSUE_DENIED_NOT_SIGNED_IN = 'Sign in to issue a licence.';
export const ISSUE_DENIED_NOT_ADMIN =
  'Only an admin can issue a licence. Licences are issued to your own account when a plan is bought.';

/**
 * Throws an Error carrying an HTTP status when the caller may not issue a licence.
 * @param {{id?: string, role?: string}|null|undefined} user the session user
 */
export function assertCanIssue(user) {
  if (!user || !user.id) {
    throw Object.assign(new Error(ISSUE_DENIED_NOT_SIGNED_IN), { status: 401 });
  }
  if (user.role !== 'admin') {
    throw Object.assign(new Error(ISSUE_DENIED_NOT_ADMIN), { status: 403 });
  }
}

// ── claiming a purchase (U-11, Rob's secure-link flow) ───────────────────────────────────────────────────
//
// The session id from the success URL IS the bearer token. These rules decide what it may produce, and they
// are pure so a guard can prove every refusal without Stripe or a database.

export const CLAIM_DENIED_UNPAID = 'That checkout has not completed. If you were charged, contact us with the receipt.';
export const CLAIM_DENIED_TAKEN = 'That purchase has already been claimed by another account.';

/**
 * @param {object} p
 * @param {{status?: string, payment_status?: string, metadata?: object}|null} p.session  Stripe checkout session
 * @param {{id: string, stripe_session_id?: string|null}|null} p.existing  licence already minted for this session
 * @param {{id?: string}|null} p.user  the signed-in account
 * @returns {{ok: true, action: 'mint'|'return'} | {ok: false, status: number, reason: string}}
 */
export function claimDecision({ session, existing, user }) {
  if (!user?.id) return { ok: false, status: 401, reason: ISSUE_DENIED_NOT_SIGNED_IN };
  if (!session) return { ok: false, status: 404, reason: 'That checkout session is not recognised.' };
  const paid = session.payment_status === 'paid' || session.status === 'complete';
  if (!paid) return { ok: false, status: 402, reason: CLAIM_DENIED_UNPAID };

  // A licence already minted for this session: hand it back only to the account that owns it, so a leaked
  // success URL cannot be used to read somebody else's licence.
  if (existing) {
    if (existing.created_by_id && existing.created_by_id !== user.id) {
      return { ok: false, status: 409, reason: CLAIM_DENIED_TAKEN };
    }
    return { ok: true, action: 'return' };
  }
  return { ok: true, action: 'mint' };
}

/** What a checkout package buys. One place, so the price list and the licence cannot drift. */
export function licenceForPackage(pkg, seats) {
  const n = Math.max(1, Number(seats) || 1);
  if (pkg === 'sdk') return { plan: 'solo', seats: n };
  if (pkg === 'sdk_ent') return { plan: 'team', seats: n };
  return null; // corpus packages buy a feed, not a licence
}
