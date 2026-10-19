-- One-time migration for the already-provisioned morpheus2 Supabase project,
-- adding the `cost_snapshots` table for the admin-only "COST TRACKER" page
-- (see schema.prisma's CostSnapshot model comment). Safe to run any time,
-- no dependency on any other table.
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-cost-snapshot-table.sql`).
-- Skip this if you're initializing a brand-new database from scratch —
-- once this ships, add the same table to manual-supabase-init.sql too.

create table if not exists cost_snapshots (
  id            text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  items         text not null,
  summary       text,
  created_date  timestamp(3) not null default now(),
  updated_date  timestamp(3) not null default now()
);
