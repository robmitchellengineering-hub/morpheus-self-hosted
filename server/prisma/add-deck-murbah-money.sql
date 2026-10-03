-- Murbah — the money half of the ledger.
--
-- Rob's audit of the old base44 deck (DECK-OLD-VS-NEW.md, §1): the old Murbah panel tracked price,
-- deposit paid, fully paid and a start–end range, and pushed the payment flags into the Calendar
-- event. The ported panel kept the calendar half, which is better here, and lost the money half.
--
-- Additive and idempotent — safe to re-run. Applied with:
--   cd server && node scripts/prod-sql.mjs prisma/add-deck-murbah-money.sql --dry-run
--   cd server && node scripts/prod-sql.mjs prisma/add-deck-murbah-money.sql
--
-- booking_date is NOT touched: it stays the start date and the thing Calendar is given, so no
-- existing date is reinterpreted.

ALTER TABLE deck_murbah_opportunities ADD COLUMN IF NOT EXISTS price double precision;

-- Defaulted false, so every existing row reads as "not paid yet" rather than unknown — which is the
-- safe direction for a money flag.
ALTER TABLE deck_murbah_opportunities ADD COLUMN IF NOT EXISTS deposit_paid boolean NOT NULL DEFAULT false;
ALTER TABLE deck_murbah_opportunities ADD COLUMN IF NOT EXISTS paid boolean NOT NULL DEFAULT false;

ALTER TABLE deck_murbah_opportunities ADD COLUMN IF NOT EXISTS end_date timestamp(3);
