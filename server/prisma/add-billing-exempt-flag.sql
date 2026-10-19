-- One-time migration for the already-provisioned morpheus2 Supabase project,
-- adding the `billing_exempt` column to `users` — a free-usage grant
-- separate from `role` (2026-09-12, Rob: wanted to give an account free
-- usage "withought giving full admin access"; role === 'admin' was this
-- app's only billing exemption until now, but it also grants the full
-- Admin Panel). See server/src/ai.js's isExempt logic and the Admin Panel's
-- "FREE USAGE GRANTS" card (AdminPanel.jsx).
-- Safe to run any time, no dependency on any other migration.
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-billing-exempt-flag.sql`).
-- Skip this if you're initializing a brand-new database from scratch --
-- once this ships, add the same column to manual-supabase-init.sql too
-- (already done as of this migration's introduction).

alter table users add column if not exists billing_exempt boolean not null default false;
