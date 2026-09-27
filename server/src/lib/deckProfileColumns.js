// DeckBusinessProfile's fee columns, and the H11 shape of reading a model whose column may not
// have been migrated yet.
//
// WHY THIS EXISTS — hazard H11, which this change would otherwise trigger on purpose
//
// `deck_business_profiles` gained fee_threshold / fee_rate_under / fee_rate_over on 2026-09-28
// (schema.prisma + server/prisma/selfdev-deck-fee-tiers.sql, H8). The SQL is applied by hand and
// the code deploys first, so for that window the schema knows about three columns the database
// does not have. `entities.js` reads with no `select` — Prisma asks for every column, Postgres
// answers P2022 — and `CommandDeckContext.jsx` lists DeckBusinessProfile on EVERY Deck load, so
// the blast radius of one unapplied column is the whole Deck failing to render rather than the
// new setting reading as absent. That is the documented incident class in KNOWN-HAZARDS.md H11
// and lib/templateCompat.js, and lib/deckInsightGate.js records the earlier decision to avoid it
// by not adding a column at all.
//
// The columns are genuinely required here, so the H11 rule is followed instead: every read of
// this model names its columns, and both the read and the write step back to the pre-migration
// shape the moment Prisma says a column is missing. Degrading to the OLD behaviour (fee settings
// simply do not persist yet) is the required direction — never "the feature is off", and never
// "the page is down".
//
// Kept pure and dependency-free so scripts/verify-deck-fee-tiers.mjs can assert the fallback in
// CI's no-install guards job.

// The three columns this change adds. Named once, so a read, a write and a guard cannot disagree
// about which fields are the new ones.
export const DECK_PROFILE_FEE_COLUMNS = ['fee_threshold', 'fee_rate_under', 'fee_rate_over'];

// Exactly the columns that existed BEFORE this change. Written out rather than derived from the
// column list above so adding a fourth fee field later cannot silently widen what the fallback
// read returns.
export const DECK_PROFILE_BASE_SELECT = {
  id: true,
  created_by_id: true,
  shop_name: true,
  tagline: true,
  contact_email: true,
  business_context: true,
  created_date: true,
  updated_date: true,
};

/** An explicit `select` for DeckBusinessProfile — with the fee columns, or without them. */
export function deckProfileSelect({ withFee = true } = {}) {
  const select = { ...DECK_PROFILE_BASE_SELECT };
  if (withFee) for (const column of DECK_PROFILE_FEE_COLUMNS) select[column] = true;
  return select;
}

// Prisma P2022 is "column does not exist" (it does not always name the column) and P2021 is a
// missing table. Either one means this environment has not had the migration applied; for a read
// or a write that named a new column, the answer is the same.
export function isMissingDeckProfileColumn(err) {
  return err?.code === 'P2022' || err?.code === 'P2021';
}

// A write that names a column the database does not have throws the same P2022 a read does, and
// the operator's ENTIRE Business-profile save would fail over a setting that is not there yet.
// Strip the fee fields and retry, so the rest of the profile still saves and the fee structure
// waits for the SQL. The fields come back missing, which the Settings form reads as the defaults
// — the old behaviour, not a broken page.
export function withoutDeckProfileFeeFields(fields) {
  const out = { ...(fields || {}) };
  for (const column of DECK_PROFILE_FEE_COLUMNS) delete out[column];
  return out;
}
