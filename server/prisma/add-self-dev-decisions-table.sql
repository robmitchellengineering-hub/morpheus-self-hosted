-- One-time migration for the already-provisioned morpheus2 Supabase project,
-- adding the `self_dev_decisions` table for the self-dev decisions log
-- (Command Deck Tier 2 #7 — see schema.prisma's SelfDevDecision model comment).
--
-- After every self-dev change that ships, the planner's one-line "what
-- changed / why" is recorded here and fed back into the planner's context on
-- the next build turn.
--
-- Safe to run any time. Run once against the morpheus2 Supabase project
-- (SQL Editor, or `psql "$DATABASE_URL" -f server/prisma/add-self-dev-decisions-table.sql`).
-- Until it is run, self-dev works normally — the decisions log is just empty
-- (lib/selfDevDecisions.js detects the missing table and degrades).

create table if not exists self_dev_decisions (
  id            text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  project_id    text not null references projects(id) on delete cascade,
  summary       text not null,
  rationale     text not null,
  ref           text,
  created_date  timestamp(3) not null default now()
);

create index if not exists self_dev_decisions_project_date_idx
  on self_dev_decisions (project_id, created_date);
