// The Murbah ledger's money field, as pure logic.
//
// Rob's audit of the old base44 deck (DECK-OLD-VS-NEW.md §1): the old Murbah panel tracked price,
// deposit paid and fully paid, and the ported one lost the money half. This is the only part of that
// which needs deciding rather than rendering, so it lives here where a guard can reach it.
//
// Dependency-free, so scripts/verify-murbah-money.mjs runs it in CI's no-install guards job.

/**
 * A price typed into the ledger.
 *
 * Returns `{ ok, value }`. `value` is:
 *   - `null` for an empty box — "no price agreed", which is NOT the same as a price of zero, and the
 *     two must not render alike;
 *   - a number otherwise.
 *
 * `ok: false` means the caller must NOT store anything: a half-typed number ("1e", "-", ".") is a
 * keystroke in progress, not a value, and letting it through puts NaN — or a coerced 0 the operator
 * never typed — into the booking. A negative price is refused for the same reason the input has
 * `min="0"`: it is a typo, not a booking.
 */
export function normalizePrice(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { ok: false, value: null };
  return { ok: true, value: n };
}
