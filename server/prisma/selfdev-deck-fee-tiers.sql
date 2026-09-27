-- Additive-only: the per-account consignment fee structure (2026-09-28).
-- Rob: "Consignment is a set fee structure but i can change it in settings." The shop's cut is
-- `fee_rate_under` percent on the whole price up to `fee_threshold`, and `fee_rate_over` percent
-- above it. Percentages, not fractions — 30 means 30% (src/pages/CommandDeck/feeTiers.js).
--
-- Everything here is `add column if not exists`; no drops, no renames, no type changes, so this
-- classifies as safe to auto-apply. Nullable on purpose: a profile nobody has edited means "use
-- the defaults" (30 / 2000 / 20), and the application resolves NULL to exactly that. It does NOT
-- touch deck_consignment_items.fee — a stored fee is what was agreed with a consignor at the
-- moment of sale, and changing this rule must never rewrite it.

alter table deck_business_profiles add column if not exists fee_threshold double precision;
alter table deck_business_profiles add column if not exists fee_rate_under double precision;
alter table deck_business_profiles add column if not exists fee_rate_over double precision;
