-- Token System Build Plan Step 3 (2026-09-01) -- pre-call reserve + reconcile
-- billing enforcement. See server/src/lib/billing.js for the implementation
-- and the decisions this migration encodes (schema.prisma's User.credit_balance
-- comment has the full reasoning).
--
-- Widens three Int columns to numeric(14,4) so fractional credits (a cheap
-- chat turn can cost less than 1 credit at the decided $5-per-1,000-credits
-- rate) don't round to zero and undercharge. Safe to run any time -- widening
-- a numeric column's precision preserves existing integer values exactly, no
-- data loss, no existing row touched beyond its type.
--
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-billing-enforcement.sql`).
-- Skip this if you're initializing a brand-new database from scratch --
-- once this ships, the same column types are already folded into
-- manual-supabase-init.sql too.

alter table users
  alter column credit_balance type numeric(14,4) using credit_balance::numeric(14,4);

alter table usage_events
  alter column credits_charged type numeric(14,4) using credits_charged::numeric(14,4);

alter table credit_transactions
  alter column credits type numeric(14,4) using credits::numeric(14,4);
