-- One-time migration for the already-provisioned morpheus2 Supabase project,
-- adding the two columns lib/contextSummary.js needs (see schema.prisma's
-- Project model comment for what these are for). Safe to run any time —
-- both columns are nullable/defaulted, so existing rows are unaffected.
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-context-summary.sql`).
-- Skip this if you're initializing a brand-new database from scratch —
-- manual-supabase-init.sql already includes these columns.

alter table projects
  add column if not exists context_summary text,
  add column if not exists context_summary_message_count integer not null default 0;
