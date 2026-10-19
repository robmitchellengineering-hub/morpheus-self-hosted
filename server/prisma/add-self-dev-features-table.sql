-- One-time migration for the already-provisioned morpheus2 Supabase project,
-- adding the `self_dev_features` table for self-dev persistent feature plans
-- (SELF-DEV-V2 A1 — see schema.prisma's SelfDevFeature model comment).
--
-- A self-dev "feature" is a multi-step plan tracked across turns: the planner
-- is given the goal + step list + which step is active on every build turn,
-- and the operator marks steps done from the FEATURE panel.
--
-- Safe to run any time. Run once against the morpheus2 Supabase project
-- (SQL Editor, or `psql "$DATABASE_URL" -f server/prisma/add-self-dev-features-table.sql`).
-- Until it is run, self-dev works normally — the FEATURE panel just reports
-- that the migration is pending (planSelfDevFeature.js / lib/selfDevFeature.js
-- detect the missing table and degrade instead of crashing).

create table if not exists self_dev_features (
  id            text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  project_id    text not null references projects(id) on delete cascade,
  title         text not null,
  goal          text not null,
  steps         text not null,
  status        text not null default 'active',
  created_date  timestamp(3) not null default now(),
  updated_date  timestamp(3) not null default now()
);

create index if not exists self_dev_features_project_status_idx
  on self_dev_features (project_id, status);
