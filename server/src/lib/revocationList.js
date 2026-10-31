// revocationList.js — the signed revocation list, built from the database instead of a file on somebody's laptop.
//
// WHY THIS REPLACES THE CRON. The list was minted on the issuing Mac by a launchd job and published to the site. That works until the
// Mac is asleep, the worktree moves, or nobody remembers — and a revocation that depends on a laptop is not a control, it is a habit.
// The database already knows every revoked jti (`licences.revoked_at`); this turns that into the same signed token the SDK already
// verifies, so there is no file, no cron and no Mac in the path.
//
// The token is PUBLIC (it lists withdrawn ids and nothing else) and signed with the issuer key the SDK already trusts.
export const TERM_DAYS = 90;
export const MAX_IDS = 1000;

/** The claims for a list. Pure, so the guard can prove the shape without a database. */
export function claimsForList(jtis, { now = Date.now(), kid = 'vvs-2026-11', termDays = TERM_DAYS } = {}) {
  const ids = [...new Set((jtis ?? []).map((j) => String(j ?? '').trim()).filter(Boolean))].slice(0, MAX_IDS);
  const iat = Math.floor(now / 1000);
  return { v: 1, kind: 'revocations', iat, exp: iat + Math.max(1, termDays) * 86_400, revocations: ids, kid };
}
