-- One-time migration for the already-provisioned morpheus2 Supabase project,
-- adding the `personality_enabled` column to `user_settings` for the
-- Settings -> Appearance "Personality" toggle (turns Morpheus's Matrix-voice
-- mentor persona off for plain, direct responses; see
-- server/src/functions/chatWithMorpheus.js's SYSTEM_PROMPT_PLAIN).
-- Safe to run any time, no dependency on any other migration.
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-personality-toggle.sql`).
-- Skip this if you're initializing a brand-new database from scratch --
-- once this ships, add the same column to manual-supabase-init.sql too
-- (already done as of this migration's introduction).

alter table user_settings add column if not exists personality_enabled boolean not null default true;
