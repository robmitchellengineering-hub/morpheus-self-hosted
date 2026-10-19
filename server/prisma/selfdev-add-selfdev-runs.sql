-- self_dev_runs — the durable record of what a self-dev run actually did.
--
-- WHY THIS EXISTS
--
-- Everything that made self-dev untrustworthy a week ago was invisible for the
-- same reason: a run left no durable trace. The merge, the deploy watch and the
-- smoke check all happened as effects inside SelfDev.jsx, so closing the tab
-- ended the pipeline and took the evidence with it; verify results and deploy
-- banners were React state; and the only durable artefacts were chat messages
-- that assert a deploy happened ("all checks green … redeploying production")
-- without any check having confirmed it. An 18% revert rate, a smoke check that
-- had never once fired and three capabilities that had never executed were all
-- discoverable *only* by reading production tables by hand — which is what the
-- 2026-09-24 audit had to do.
--
-- This table is the smallest thing that changes that: one row per pipeline
-- stage, with a run id shared across the stages of one run, how long each took,
-- and how it ended.
--
-- ONE ROW PER STAGE, not one row per run: stages execute independently and some
-- of them fail before the next is reached, so an append-only row per stage is
-- what can be written without a read-modify-write race — the same reasoning
-- lib/selfDevDecisions.js uses for stamping.
--
-- ADDITIVE AND IDEMPOTENT, per KNOWN-HAZARDS.md H8/H11. The code that writes
-- here degrades to silence when the table is absent (see lib/selfDevRuns.js), so
-- a deployment that has not run this file loses the record, never the pipeline —
-- which matters because this deployment's migration applier has never been
-- invoked, and `self_dev_migrations` does not exist to tell anyone otherwise.
--
-- Raw SQL, deliberately not a Prisma model, matching lib/selfDevMigrations.js's
-- own `self_dev_migrations` table: bookkeeping for self-dev does not belong in
-- the application's data model, and keeping it out of schema.prisma keeps it out
-- of the H11 blast radius entirely (a listed entity with no `select` throws
-- P2022 on a database that has not had the column added).

CREATE TABLE IF NOT EXISTS self_dev_runs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  created_by_id TEXT,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL,
  detail        TEXT,
  duration_ms   INTEGER,
  created_date  TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

-- Reading is always "the stages of one run" or "the most recent runs", scoped to
-- the account that drove them — every other self-dev lookup in this codebase is
-- owner-scoped, and a run record that leaked another admin's activity would be
-- the same class of mistake as the unscoped self-dev lookup buildDeckWidget.js
-- had to fix.
CREATE INDEX IF NOT EXISTS self_dev_runs_run_id_idx ON self_dev_runs (run_id);
CREATE INDEX IF NOT EXISTS self_dev_runs_created_idx ON self_dev_runs (created_by_id, created_date DESC);
