// DeckBusinessProfile's optional columns, and the H11 shape of reading a model whose column may not
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
// 2026-10-04 — a SECOND optional group, `operating_regions`, for the same reason and with the same
// treatment (selfdev-deck-operating-regions.sql). It is read on every Jarvis message, so the same
// rule applies: name the columns, and step back the moment Prisma says one is missing. The
// fallback order is NEWEST FIRST — regions, then fee, then the pre-2026-09-28 shape — so an
// environment missing only the newest column keeps the fee settings rather than losing both.
//
// The columns are genuinely required here, so the H11 rule is followed instead: every read of
// this model names its columns, and both the read and the write step back to the pre-migration
// shape the moment Prisma says a column is missing. Degrading to the OLD behaviour (the setting
// simply does not persist yet) is the required direction — never "the feature is off", and never
// "the page is down".
//
// Kept pure and dependency-free so the guards can assert the fallback in CI's no-install job.

// The columns each change adds. Named once, so a read, a write and a guard cannot disagree about
// which fields are the new ones.
export const DECK_PROFILE_FEE_COLUMNS = ['fee_threshold', 'fee_rate_under', 'fee_rate_over'];
export const DECK_PROFILE_REGION_COLUMNS = ['operating_regions'];

// Exactly the columns that existed BEFORE those changes. Written out rather than derived from the
// column lists above so adding a fourth field later cannot silently widen what the fallback read
// returns.
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

/**
 * An explicit `select` for DeckBusinessProfile.
 *
 * `withFee: false` means the PRE-2026-09-28 shape — base only, regions included in "not base" — so
 * the oldest step-down attempt keeps meaning exactly what it always meant.
 */
export function deckProfileSelect({ withFee = true, withRegions = true } = {}) {
  const select = { ...DECK_PROFILE_BASE_SELECT };
  if (!withFee) return select;
  for (const column of DECK_PROFILE_FEE_COLUMNS) select[column] = true;
  if (withRegions) for (const column of DECK_PROFILE_REGION_COLUMNS) select[column] = true;
  return select;
}

/**
 * The read attempts, NEWEST COLUMNS FIRST. One rule, shared by both read paths (`entities.js` and
 * `deckBusinessProfile.js`), so they cannot step down differently.
 *
 * The middle attempt matters: an environment that has the fee migration but not the regions one
 * keeps its fee settings instead of falling all the way back for a column it does have.
 */
export function deckProfileSelectAttempts() {
  return [
    deckProfileSelect(),
    deckProfileSelect({ withRegions: false }),
    deckProfileSelect({ withFee: false }),
  ];
}

// Prisma P2022 is "column does not exist" (it does not always name the column) and P2021 is a
// missing table. Either one means this environment has not had the migration applied; for a read
// or a write that named a new column, the answer is the same.
export function isMissingDeckProfileColumn(err) {
  return err?.code === 'P2022' || err?.code === 'P2021';
}

// A write that names a column the database does not have throws the same P2022 a read does, and
// the operator's ENTIRE Business-profile save would fail over a setting that is not there yet.
// Strip the newest fields and retry, so the rest of the profile still saves and the new setting
// waits for the SQL. The fields come back missing, which the Settings form reads as the defaults
// — the old behaviour, not a broken page.
export function withoutDeckProfileFeeFields(fields) {
  const out = { ...(fields || {}) };
  for (const column of DECK_PROFILE_FEE_COLUMNS) delete out[column];
  return out;
}

export function withoutDeckProfileRegionFields(fields) {
  const out = { ...(fields || {}) };
  for (const column of DECK_PROFILE_REGION_COLUMNS) delete out[column];
  return out;
}

/**
 * The write attempts, NEWEST COLUMNS FIRST, each naming what it dropped.
 *
 * Attempt 1 carries everything. Attempt 2 drops only the regions column (the fee migration may be
 * present without it). Attempt 3 drops the fee fields too — and drops the regions with them,
 * because that is the pre-2026-09-28 shape the oldest fallback has always meant.
 */
export function deckProfileWriteAttempts(data) {
  return [
    { data, droppedFields: [] },
    { data: withoutDeckProfileRegionFields(data), droppedFields: ['regions'] },
    { data: withoutDeckProfileFeeFields(withoutDeckProfileRegionFields(data)), droppedFields: ['regions', 'fee'] },
  ];
}

// The keys the API adds to a write that had to drop fields. Named once so the server that sets
// them, the Settings form that renders them and the guards that assert both cannot disagree.
export const DECK_PROFILE_FEE_DROPPED = 'fee_fields_dropped';
export const DECK_PROFILE_REGION_DROPPED = 'region_fields_dropped';

/** Did this write actually carry a fee field? False for every ordinary profile save. */
export function hasDeckProfileFeeFields(fields) {
  return DECK_PROFILE_FEE_COLUMNS.some((column) => Object.prototype.hasOwnProperty.call(fields || {}, column));
}

/** Did this write actually carry an operating-regions value? */
export function hasDeckProfileRegionFields(fields) {
  return DECK_PROFILE_REGION_COLUMNS.some((column) => Object.prototype.hasOwnProperty.call(fields || {}, column));
}

/**
 * What a DeckBusinessProfile write returns.
 *
 * The retries above store everything EXCEPT the fields that could not be written, so a dropped
 * write must not come back looking like a plain success: a dropped write that reads as success is
 * worse than a failed one (the same shape as the partial compile save that reported "Build
 * complete"). When — and only when — a fallback was used for a write that carried those fields,
 * the row is returned with `fee_fields_dropped` / `region_fields_dropped` so Settings can say so
 * in plain words. A write with neither field, or one that kept them, carries no marker at all.
 * Pure, so the guards can exercise every case.
 *
 * @param {object} row the stored row (whatever the retry returned)
 * @param {object} fields the data the caller originally asked to write
 * @param {{droppedFields?: string[]}} [outcome] which groups the missing-column fallback had to drop
 */
export function deckProfileWriteResult(row, fields, { droppedFields = [] } = {}) {
  if (!row || typeof row !== 'object') return row;
  const markers = {};
  if (droppedFields.includes('fee') && hasDeckProfileFeeFields(fields)) markers[DECK_PROFILE_FEE_DROPPED] = true;
  if (droppedFields.includes('regions') && hasDeckProfileRegionFields(fields)) markers[DECK_PROFILE_REGION_DROPPED] = true;
  return Object.keys(markers).length ? { ...row, ...markers } : row;
}
