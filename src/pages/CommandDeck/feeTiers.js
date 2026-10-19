// The consignment fee structure — the ONE place a consignment fee is derived.
//
// Until 2026-09-28 the rule was hardcoded inside deckConstants.commissionFor: 30% of the whole
// price up to $2000, 20% above. Rob: "Consignment is a set fee structure but i can change it in
// settings." It now comes from the account's own DeckBusinessProfile
// (fee_threshold / fee_rate_under / fee_rate_over), defaulting to exactly those numbers for an
// account that has never opened Settings.
//
// WHY THIS STAYS A PURE DERIVATION OVER THE TIERS IT IS HANDED, AND IS NEVER RE-RUN OVER STORED
// DATA: a fee is computed once, at the moment of sale, and written to deck_consignment_items.fee.
// server/src/lib/deckSnapshot.js then sums the STORED fee to say what is owed to a consignor.
// That is deliberate — editing the rule must never rewrite money already agreed with someone, so
// nothing here (and nothing in the app) recomputes a fee for a row that already has one.
// scripts/verify-deck-fee-tiers.mjs pins both halves.
//
// RATES ARE PERCENTAGES, THE UNIT A HUMAN TYPES: 30 means 30%, and the DB columns hold that same
// number (fee_rate_under = 30). commissionFor() is the only place that divides by 100. The input
// format is decided once, here — a bare "0.3" means 0.3%, not a third — and the Settings field
// carries the "%" in its label so the unit is never a guess (Rob reads these numbers off a phone).

export const DEFAULT_FEE_TIERS = { threshold: 2000, rateUnder: 30, rateOver: 20 };

// A blank field in Settings means "use the default", which is NOT the same as zero — a blank rate
// is not a 0% fee. Clamping only ever rescues a value that reached the database some other way (a
// hand-run UPDATE); the Settings form refuses to store one in the first place (parseFeeTierInput).
const RATE_MIN = 0;
const RATE_MAX = 100;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function num(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Fill any missing or unusable tier field from the default, and clamp nonsense into a legal range.
// One field falling back does not take the other two with it, so a half-written profile cannot
// silently become a 0%-fee shop.
export function normalizeFeeTiers(tiers) {
  const t = tiers || {};
  return {
    threshold: Math.max(0, num(t.threshold, DEFAULT_FEE_TIERS.threshold)),
    rateUnder: clamp(num(t.rateUnder, DEFAULT_FEE_TIERS.rateUnder), RATE_MIN, RATE_MAX),
    rateOver: clamp(num(t.rateOver, DEFAULT_FEE_TIERS.rateOver), RATE_MIN, RATE_MAX),
  };
}

// The DB columns → the tier shape. A profile that has never been edited has all three NULL, which
// is a call to action, not an error: it is the default structure.
export function feeTiersFromProfile(profile) {
  const p = profile || {};
  return normalizeFeeTiers({
    threshold: p.fee_threshold,
    rateUnder: p.fee_rate_under,
    rateOver: p.fee_rate_over,
  });
}

// The whole rule: the shop's cut on `price`, in dollars. This is the ONE derivation of a fee.
// Called with no tiers it is exactly the pre-2026-09-28 behaviour (guards and tests rely on that).
export function commissionFor(price, tiers) {
  const t = normalizeFeeTiers(tiers);
  const p = Number(price) || 0;
  return p <= t.threshold ? (p * t.rateUnder) / 100 : (p * t.rateOver) / 100;
}

// What the consignor receives on a sale of `price`. Kept beside the cut so the two can never be
// derived from different tiers in a display string.
export function consignorProceeds(price, tiers) {
  const p = Number(price) || 0;
  return p - commissionFor(p, tiers);
}

// "30" / "27.5" — no trailing zeros. Used by the Settings preview and the row label.
export function formatFeeRate(rate) {
  return String(Number(Number(rate).toFixed(2)));
}

// The rate that applies at `price`. This replaces the hardcoded `price > 2000 ? '20%' : '30%'`
// that used to sit in signal_chain.jsx and would have contradicted the setting.
export function feeRateLabel(price, tiers) {
  const t = normalizeFeeTiers(tiers);
  const p = Number(price) || 0;
  return `${formatFeeRate(p <= t.threshold ? t.rateUnder : t.rateOver)}%`;
}

// Validate what a human typed in Settings and turn it into the API payload.
//
// Returns { ok, errors, fields }. `fields` are the three DB columns: a NUMBER when the field was
// filled in, and null when it was left blank ("use the default"). A field that is not a number,
// is negative, or is a rate outside 0–100% is reported in `errors` and its column is left null,
// so nothing nonsense is stored — the form disables Save while !ok, and this is the same rule the
// payload is built from, so the two cannot drift.
export function parseFeeTierInput(input) {
  const src = input || {};
  const errors = {};
  const fields = { fee_threshold: null, fee_rate_under: null, fee_rate_over: null };
  const specs = [
    ['fee_threshold', 'threshold', 'Threshold'],
    ['fee_rate_under', 'rateUnder', 'Rate up to the threshold'],
    ['fee_rate_over', 'rateOver', 'Rate above the threshold'],
  ];
  for (const [column, key, label] of specs) {
    const raw = src[column] !== undefined ? src[column] : src[key];
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) { errors[column] = `${label} must be a number.`; continue; }
    if (column === 'fee_threshold') {
      if (n < 0) { errors[column] = `${label} cannot be negative.`; continue; }
    } else if (n < RATE_MIN || n > RATE_MAX) {
      errors[column] = `${label} must be between 0 and 100%.`;
      continue;
    }
    fields[column] = n;
  }
  return { ok: Object.keys(errors).length === 0, errors, fields };
}
