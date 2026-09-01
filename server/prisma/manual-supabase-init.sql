-- Morpheus — hand-written DDL matching server/prisma/schema.prisma exactly
-- (table/column names via @@map, types per Prisma's default Postgres
-- mapping: String -> text, DateTime -> timestamp(3), no timezone).
--
-- Why hand-written instead of `prisma migrate deploy`: this was generated
-- in an environment with no npm registry access, so the Prisma CLI could
-- not run. This SQL creates the exact same schema `prisma migrate deploy`
-- would have, so `npx prisma generate` (run locally, where you DO have
-- registry access) produces a client that matches this database with no
-- further migration needed. If you ever do get `prisma migrate dev`
-- running against this database later, baseline it first (`prisma migrate
-- resolve --applied <name>`) so Prisma doesn't try to recreate these
-- tables.
--
-- Run this once, in full, in the Supabase SQL editor (or `psql`) against a
-- fresh database.

create extension if not exists pgcrypto;

create table users (
  id text primary key default gen_random_uuid()::text,
  email text not null unique,
  password_hash text not null,
  full_name text,
  role text not null default 'user',
  google_id text unique,
  email_verified boolean not null default false,
  otp_code text,
  otp_expires timestamp(3),
  -- Token System Build Plan Step 1: 200 free signup credits on every new
  -- account. See schema.prisma's "TOKEN SYSTEM / BILLING METERING" comment.
  credit_balance integer not null default 200,
  created_date timestamp(3) not null default now(),
  updated_date timestamp(3) not null default now()
);

create table user_settings (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null unique references users(id) on delete cascade,
  ai_mode text not null default 'default',
  ai_base_url text,
  ai_api_key text,
  ai_model text,
  planner_model text,
  coder_model text,
  reviewer_model text,
  diagnosis_model text,
  connections text,
  tts_mode text not null default 'default',
  tts_engine text not null default 'elevenlabs',
  tts_api_key text,
  tts_voice_id text,
  tts_endpoint text,
  created_date timestamp(3) not null default now(),
  updated_date timestamp(3) not null default now()
);

create table github_connections (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null unique references users(id) on delete cascade,
  login text not null,
  access_token text not null,
  scope text,
  -- Only populated when the GitHub OAuth App has "Token expiration" on —
  -- see server/src/lib/github.js's silent-refresh logic.
  refresh_token text,
  expires_at timestamp(3),
  refresh_token_expires_at timestamp(3),
  created_date timestamp(3) not null default now()
);

create table projects (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'init',
  compile_target text not null default 'source',
  project_type text not null default 'frontend',
  polish_ui boolean not null default false,
  context_summary text, -- rolling "critical logic" memory for long-lived projects, see lib/contextSummary.js
  context_summary_message_count integer not null default 0,
  created_date timestamp(3) not null default now(),
  updated_date timestamp(3) not null default now()
);

create table project_files (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  path text not null,
  content text not null,
  file_url text,
  language text not null default 'text',
  created_date timestamp(3) not null default now(),
  updated_date timestamp(3) not null default now(),
  unique (project_id, path)
);

create table chat_messages (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  role text not null,
  content text not null,
  created_date timestamp(3) not null default now()
);

create table file_snapshots (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  label text,
  files text,
  file_url text,
  created_date timestamp(3) not null default now()
);

create table usage_records (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  action_type text not null,
  credits integer not null default 1,
  project_id text references projects(id) on delete set null,
  project_name text,
  metadata text,
  created_date timestamp(3) not null default now()
);

create table templates (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  project_id text references projects(id) on delete set null,
  name text not null,
  description text,
  long_description text,
  author_name text,
  author_id text,
  files text not null,
  artifact_files text, -- optional JSON [{name, file_url}] — compiled binaries a seller
                       -- chose to attach alongside the source; null = source-only
  icon text,
  screenshots text,
  compile_target text not null default 'source',
  tags text,
  category text not null default 'general',
  install_count integer not null default 0,
  file_count integer not null default 0,
  price double precision not null default 0, -- dollars (e.g. 9.99), same convention as the original Base44 entity
  stripe_product_id text,
  stripe_price_id text,
  created_date timestamp(3) not null default now(),
  updated_date timestamp(3) not null default now()
);

create table purchases (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  template_id text references templates(id) on delete set null, -- nullable + set null, not cascade:
                                                                  -- a seller deleting their account removes
                                                                  -- their templates but must not destroy other
                                                                  -- buyers' purchase/receipt history
  template_name text,
  buyer_id text not null,
  buyer_email text,
  seller_id text not null,
  amount double precision not null default 0, -- dollars, same convention as the original
  platform_cut double precision not null default 0,
  seller_cut double precision not null default 0,
  stripe_session_id text not null unique,
  status text not null default 'paid',
  created_date timestamp(3) not null default now()
);

-- One-off "keep the lights on" donations from the landing page — no FK to
-- users, since base44's donate widget works for anonymous, pre-login
-- visitors too. Kept separate from `purchases` so donation totals never mix
-- into marketplace sales/payout reporting.
create table donations (
  id text primary key default gen_random_uuid()::text,
  amount double precision not null default 0,
  donor_email text,
  stripe_session_id text not null unique,
  status text not null default 'paid',
  created_date timestamp(3) not null default now()
);

-- Landing page's public "SUGGEST AN IMPROVEMENT" box — no FK to users,
-- same reasoning as donations (anonymous, pre-login visitors can submit).
create table feedback (
  id text primary key default gen_random_uuid()::text,
  type text not null default 'feature',
  message text not null,
  email text,
  status text not null default 'new',
  created_date timestamp(3) not null default now()
);

create table backend_configs (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  project_id text not null unique references projects(id) on delete cascade,
  custom_domain text,
  api_keys text,
  deploy_platform text,
  deploy_url text,
  deploy_status text,
  created_date timestamp(3) not null default now(),
  updated_date timestamp(3) not null default now()
);

create table rebuild_docs (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  version text not null,
  content text not null,
  content_size integer not null default 0,
  file_url text,
  created_date timestamp(3) not null default now(),
  updated_date timestamp(3) not null default now()
);

-- Admin-only "MORPHEUS UPDATES PLAN" AI synthesis tool — reads the feedback
-- table above, so create this after it.
create table updates_plans (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  content text not null,
  feedback_count integer not null default 0,
  created_date timestamp(3) not null default now(),
  updated_date timestamp(3) not null default now()
);

-- Admin-only "COST TRACKER" page — running tally of hosting/domain/AI-key
-- costs, entered and edited by hand (no live billing-API polling anywhere
-- in this stack).
create table cost_snapshots (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  items text not null,
  summary text,
  created_date timestamp(3) not null default now(),
  updated_date timestamp(3) not null default now()
);

-- Token System Build Plan Step 1/2: real per-call usage metering + admin
-- pricing catalog + token-block purchase ledger. See
-- TOKEN-SYSTEM-BUILD-PLAN.md and schema.prisma's "TOKEN SYSTEM / BILLING
-- METERING" section comment.
create table usage_events (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  role text,
  provider text not null,
  model_id text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd double precision not null default 0,
  credits_charged integer not null default 0,
  project_id text,
  created_date timestamp(3) not null default now()
);

create table model_catalog_entries (
  id text primary key default gen_random_uuid()::text,
  model_id text not null unique,
  provider text,
  input_price_per_m double precision,
  output_price_per_m double precision,
  markup_multiplier double precision not null default 2.0,
  active boolean not null default true,
  created_date timestamp(3) not null default now(),
  updated_date timestamp(3) not null default now()
);

create table credit_transactions (
  id text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  credits integer not null,
  amount_usd double precision not null default 0,
  intended_net_usd double precision not null default 0,
  stripe_session_id text unique,
  status text not null default 'paid',
  is_first_purchase boolean not null default false,
  created_date timestamp(3) not null default now()
);

-- Hot list/filter query paths (see SCALING.md Stage 2)
create index idx_projects_owner on projects(created_by_id, created_date);
create index idx_chat_messages_project on chat_messages(project_id, created_date);
create index idx_usage_records_owner on usage_records(created_by_id, created_date);
create index idx_project_files_project on project_files(project_id);
create index idx_usage_events_owner on usage_events(created_by_id, created_date);
