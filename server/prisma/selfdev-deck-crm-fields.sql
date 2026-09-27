-- Additive-only: the CRM fields for repair jobs and consignment items (2026-09-27).
-- Everything here is `add column`; no drops, no renames, no type changes, so this classifies as
-- safe to auto-apply. Nullable (or defaulted) on purpose: existing rows keep working, and the
-- application treats a missing value as "not recorded yet" rather than writing a guess.

alter table deck_consignment_items add column if not exists person_id text;
alter table deck_consignment_items add column if not exists fee double precision;
alter table deck_consignment_items add column if not exists sold_price double precision;
alter table deck_consignment_items add column if not exists sold_date timestamp(3);
alter table deck_consignment_items add column if not exists paid_out boolean not null default false;

alter table deck_repair_jobs add column if not exists person_id text;
alter table deck_repair_jobs add column if not exists quote double precision;
alter table deck_repair_jobs add column if not exists promised_date timestamp(3);
alter table deck_repair_jobs add column if not exists completed_date timestamp(3);
alter table deck_repair_jobs add column if not exists paid boolean not null default false;
