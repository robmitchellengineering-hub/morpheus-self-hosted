-- provider_balance_readings — what the provider actually holds, over time.
--
-- WHY THIS EXISTS
--
-- The product reports a cost figure that is an ESTIMATE: `UsageEvent.cost_usd`,
-- computed from a static rate table (lib/costEstimate.js MODEL_PRICING) rather
-- than from a bill. On 2026-09-24 that table was measured at roughly 2x the real
-- DeepSeek charge — 30 days of the estimate came to $172.75 against an actual
-- spend under $100 — and the retail credits charged on top of it are 3.52x the
-- estimate again. So every cost number the platform shows, and any decision
-- built on one, is wrong by a factor of about two, in a direction that flatters
-- the "this is expensive" story.
--
-- The fix is not a better table. The provider publishes a real balance
-- (GET https://api.deepseek.com/user/balance, already polled every 15 minutes by
-- lib/deepseekBalance.js) and the DIFFERENCE between two readings over a window
-- IS the spend, with no pricing model in the path. This table stores those
-- readings so a delta can be computed at all — the poll result was previously
-- written to stdout and thrown away, which is why the only way to answer "what
-- did the last 30 days actually cost" was to read the estimate and guess.
--
-- Additive and idempotent per KNOWN-HAZARDS.md H8, and applied to production
-- before the code that writes to it ships.

CREATE TABLE IF NOT EXISTS provider_balance_readings (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  balance_usd   DOUBLE PRECISION NOT NULL,
  read_at       TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

-- Both reads are "the readings in a window, oldest and newest".
CREATE INDEX IF NOT EXISTS provider_balance_provider_time_idx
  ON provider_balance_readings (provider, read_at DESC);
