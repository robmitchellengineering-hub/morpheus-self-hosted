// The one piece of Murbah's booking arithmetic worth testing: what end date an all-day Calendar event
// needs.
//
// A booking is a RANGE to the operator (start–end, both inclusive) and a pair of dates to Calendar,
// where `end.date` is EXCLUSIVE. Getting that wrong shifts every booking by a day in the place Rob
// actually reads it, silently, which is why it lives here rather than inline in the function that
// happens to call Google.
//
// Dependency-free, so scripts/verify-murbah-money.mjs runs it in CI's no-install guards job.

/**
 * The exclusive end date for an all-day event, as `YYYY-MM-DD`.
 *
 * `endDate` is optional: with none, this is the day after `bookingDate`, which is exactly what the
 * sync did before the range existed — so adding the range cannot change a single-day booking.
 */
export function exclusiveEndDate(bookingDate, endDate) {
  const base = endDate || bookingDate;
  if (!base) return null;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * What goes in the Calendar event's description: the money, then the note.
 *
 * The flags are ALWAYS stated, so "not mentioned" can never be read as "not paid" — that ambiguity is
 * the whole reason a payment flag is worth writing down. This mirrors what the old base44 deck's
 * ledger pushed into the event description on every edit.
 */
export function bookingDescription({ price, deposit_paid, paid, note } = {}) {
  const money = [
    price != null && price !== '' ? `Price: ${price}` : null,
    `Deposit paid: ${deposit_paid ? 'yes' : 'no'}`,
    `Paid in full: ${paid ? 'yes' : 'no'}`,
  ].filter(Boolean).join('\n');
  return [money, note || ''].filter(Boolean).join('\n\n');
}
