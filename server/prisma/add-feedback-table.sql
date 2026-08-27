-- One-time migration for the already-provisioned morpheus2 Supabase project,
-- adding the `feedback` table for the landing-page "SUGGEST AN IMPROVEMENT"
-- box (see schema.prisma's Feedback model comment for why this has no FK to
-- users). Safe to run any time.
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-feedback-table.sql`).
-- Skip this if you're initializing a brand-new database from scratch —
-- once this ships, add the same table to manual-supabase-init.sql too.

create table if not exists feedback (
  id           text primary key default gen_random_uuid()::text,
  type         text not null default 'feature',
  message      text not null,
  email        text,
  status       text not null default 'new',
  created_date timestamp(3) not null default now()
);
