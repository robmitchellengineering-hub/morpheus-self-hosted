-- One-time migration for the already-provisioned morpheus2 Supabase project,
-- adding the `donations` table for the landing-page "KEEP MORPHEUS ALIVE"
-- donate widget (see schema.prisma's Donation model comment for why this is
-- separate from `purchases`). Safe to run any time.
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-donations-table.sql`).
-- Skip this if you're initializing a brand-new database from scratch —
-- once this ships, add the same table to manual-supabase-init.sql too.

create table if not exists donations (
  id                 text primary key default gen_random_uuid()::text,
  amount             double precision not null default 0,
  donor_email        text,
  stripe_session_id  text not null unique,
  status             text not null default 'paid',
  created_date       timestamp(3) not null default now()
);
