// Pure, dependency-free half of the billing reconcile — extracted so
// scripts/verify-billing-clamp.mjs can assert the invariant in CI's NO-INSTALL
// guards job.
//
// WHY THIS IS A SEPARATE FILE
//
// It first lived in lib/billing.js, and the verify script imported it from
// there. That passed locally and FAILED in CI:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@prisma/client'
//   imported from server/src/db.js
//
// billing.js imports the Prisma client via db.js, and the guards job
// deliberately runs without `npm install` (hazard H4 — server/package-lock.json
// is untracked, so it *cannot* install). A "pure" check that transitively pulls
// in a runtime dependency is not pure, and it takes the whole guards job down
// with it — the same module-load failure class as H12, one level subtler
// because every *relative* import resolves fine and only a *package* import
// fails.
//
// The rule this embodies: anything a no-install guard needs must be reachable
// without a package boundary. scripts/verify-guards-no-install.mjs now enforces
// it mechanically, so this cannot recur silently.

/**
 * Given what a call owes beyond its pre-call reservation, and what the account
 * actually holds, decide how much to take and how much to absorb.
 *
 * The invariant — asserted by scripts/verify-billing-clamp.mjs over a 41k-case
 * sweep — is that `take` never exceeds the balance, so a post-call true-up can
 * never drive an account below zero. That invariant is what the product's
 * "hard stop before overspend" claim depends on.
 *
 * @param {number} owed credits owed beyond the reservation (>= 0 in practice)
 * @param {number} available credits the account currently holds (may be < 0 if
 *   it was already negative from before this fix)
 * @returns {{take: number, absorb: number}}
 */
export function splitOvershoot(owed, available) {
  const take = Math.min(Math.max(0, owed), Math.max(0, available));
  return { take, absorb: Math.max(0, owed) - take };
}
