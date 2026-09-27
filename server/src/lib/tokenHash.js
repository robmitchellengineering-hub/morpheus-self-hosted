// The one place a bearer token is turned into the value we store.
//
// WHY THIS IS ITS OWN MODULE (2026-09-28): this repo now has four scoped token
// kinds — widget (`wgt_`), device (`dvc_`), operator (`opr_`, env-resident) and
// the per-app capability grant (`apc_`) — and until this file existed three of
// them spelled `crypto.createHash('sha256').update(raw).digest('hex')` out for
// themselves. A second hashing routine is exactly the kind of "same shape, newer
// copy" drift that H15 is about, so all of them now share this one.
//
// It imports only `node:crypto`, which keeps it usable from CI's no-install
// guards job (H4) — the guard for the capability layer exercises `sameToken`
// directly, against real source, with no database and no server boot.
import crypto from 'node:crypto';

/**
 * SHA-256 of a token value, lowercase hex. The hash is what is stored; the token
 * itself never is, and is never logged (see operatorTokenFingerprint for the
 * convention that replaced printing a prefix).
 */
export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw ?? ''), 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two token values.
 *
 * Both sides go through SHA-256 first, so the buffers are always the same length
 * and `timingSafeEqual` cannot throw on a length mismatch — a length-mismatch
 * throw would itself be an oracle. This leaks nothing about how much of a wrong
 * guess was right, and never returns either value.
 *
 * Used to compare the `app_id` a capability request names against the one folded
 * into its grant: that check decides whether a token minted for app A can act on
 * app B, so it must not be a `===`.
 */
export function sameToken(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  // An empty side is never a match. A caller comparing two unset values must not be
  // handed `true`: in a grant check that reads as "an app that named no app
  // satisfies a row that named no app", which is the opposite of the isolation this
  // function exists to enforce.
  if (!left || !right) return false;
  const leftDigest = crypto.createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(right, 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}
