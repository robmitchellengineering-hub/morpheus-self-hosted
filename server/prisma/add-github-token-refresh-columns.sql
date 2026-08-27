-- One-time migration for the already-provisioned morpheus2 Supabase project.
--
-- Adds refresh-token support to github_connections so Morpheus can silently
-- renew a GitHub OAuth token instead of it dying every ~8 hours when the
-- GitHub OAuth App's "Token expiration" optional feature is enabled. See
-- server/src/lib/github.js (getGithubConnection / tryRefreshGithubToken) and
-- server/src/routes/connections.routes.js (/github/callback) for the code
-- that reads/writes these.
--
-- All three columns are nullable, so this is safe to run any time and
-- existing connections are unaffected until the user reconnects (or their
-- current token naturally hits its next expiry and gets refreshed).
--
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-github-token-refresh-columns.sql`).
-- Skip this if you're initializing a brand-new database from scratch —
-- manual-supabase-init.sql's github_connections table already includes
-- these columns.

alter table github_connections add column if not exists refresh_token text;
alter table github_connections add column if not exists expires_at timestamp(3);
alter table github_connections add column if not exists refresh_token_expires_at timestamp(3);
