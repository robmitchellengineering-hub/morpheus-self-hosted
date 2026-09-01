-- One-time migration for the already-provisioned morpheus2 Supabase project,
-- adding the Token System Build Plan's Step 1 schema (see
-- TOKEN-SYSTEM-BUILD-PLAN.md and schema.prisma's "TOKEN SYSTEM / BILLING
-- METERING" section comment). Safe to run any time -- purely additive, no
-- existing table or column is altered except the new `credit_balance`
-- column on `users`.
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-token-billing-tables.sql`).
-- Skip this if you're initializing a brand-new database from scratch --
-- once this ships, the same tables are already folded into
-- manual-supabase-init.sql too.

alter table users add column if not exists credit_balance integer not null default 200;

create table if not exists usage_events (
  id              text primary key default gen_random_uuid()::text,
  created_by_id   text not null references users(id) on delete cascade,
  role            text,
  provider        text not null,
  model_id        text not null,
  input_tokens    integer not null default 0,
  output_tokens   integer not null default 0,
  cost_usd        double precision not null default 0,
  credits_charged integer not null default 0,
  project_id      text,
  created_date    timestamp(3) not null default now()
);

create index if not exists usage_events_created_by_id_idx on usage_events(created_by_id);

create table if not exists model_catalog_entries (
  id                 text primary key default gen_random_uuid()::text,
  model_id           text not null unique,
  provider           text,
  input_price_per_m  double precision,
  output_price_per_m double precision,
  markup_multiplier  double precision not null default 2.0,
  active             boolean not null default true,
  created_date       timestamp(3) not null default now(),
  updated_date       timestamp(3) not null default now()
);

create table if not exists credit_transactions (
  id                 text primary key default gen_random_uuid()::text,
  created_by_id      text not null references users(id) on delete cascade,
  credits            integer not null,
  amount_usd         double precision not null default 0,
  intended_net_usd   double precision not null default 0,
  stripe_session_id  text unique,
  status             text not null default 'paid',
  is_first_purchase  boolean not null default false,
  created_date       timestamp(3) not null default now()
);
