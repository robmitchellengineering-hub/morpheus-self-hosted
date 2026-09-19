-- Data repair: clamp credit balances that went negative.
--
-- WHY
--
-- Before 2026-09-19, reconcileCredits() applied the post-call true-up
-- unconditionally, so a call whose real cost exceeded its pre-call reservation
-- could take an account below zero. One production account ended up at
-- -3.7712 credits: 200 free signup credits + a 400-credit purchase = 600,
-- charged 603.77 across its life, and the final call's true-up took it under.
--
-- The code is fixed (server/src/lib/billingClamp.js — the true-up now takes
-- only what the account holds and absorbs the remainder), so no NEW negative
-- balances can appear. This repairs the one that already exists.
--
-- Bounded on purpose: `WHERE credit_balance < 0` matches only the accounts in
-- the bug's own state, and is idempotent — running it twice is a no-op.
--
-- Run with the data-repair path, which requires an explicit flag and refuses
-- any statement without a WHERE clause:
--   cd server && node scripts/prod-sql.mjs prisma/repair-negative-credit-balances.sql --data-repair --dry-run
--   cd server && node scripts/prod-sql.mjs prisma/repair-negative-credit-balances.sql --data-repair

UPDATE users
   SET credit_balance = 0
 WHERE credit_balance < 0;
