-- One-time migration for the already-provisioned morpheus2 Supabase project,
-- adding the `updates_plans` table for the admin-only "MORPHEUS UPDATES
-- PLAN" AI synthesis tool (see schema.prisma's UpdatesPlan model comment).
-- Safe to run any time. Requires the `feedback` table to already exist
-- (add-feedback-table.sql) since this tool reads from it, though there is
-- no FK between them — feedback rows are anonymous/unowned.
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-updates-plan-table.sql`).
-- Skip this if you're initializing a brand-new database from scratch —
-- once this ships, add the same table to manual-supabase-init.sql too.

create table if not exists updates_plans (
  id             text primary key default gen_random_uuid()::text,
  created_by_id  text not null references users(id) on delete cascade,
  content        text not null,
  feedback_count integer not null default 0,
  created_date   timestamp(3) not null default now(),
  updated_date   timestamp(3) not null default now()
);
