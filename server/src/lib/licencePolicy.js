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
