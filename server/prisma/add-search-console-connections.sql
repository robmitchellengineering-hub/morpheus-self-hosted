-- Search Console connection — one row per account (schema.prisma's
-- SearchConsoleConnection). Additive and idempotent: safe to re-run.
--
-- WHY ITS OWN TABLE rather than another scope on GoogleDriveConnection:
-- reading search performance needs its own consent
-- (webmasters.readonly), it is useful to someone who has no Drive storage
-- connection at all, and folding it into the Drive row would force every Drive
-- user to re-consent for a scope their feature does not use. Same reasoning as
-- DeckGoogleConnection's separate row (see schema.prisma).
--
-- `property` is the Search Console property the account chose to read — either a
-- URL-prefix property ('https://valiantmusic.com.au/') or a Domain property
-- ('sc-domain:valiantmusic.com.au'). NULL until they pick one, which is a real
-- state: a verified account can have several properties, and a zero-property
-- account has none.
--
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every other
-- Morpheus table) or: node scripts/prod-sql.mjs prisma/add-search-console-connections.sql

CREATE TABLE IF NOT EXISTS search_console_connections (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id  text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  gsc_email      text NOT NULL,
  access_token   text NOT NULL,
  scope          text,
  refresh_token  text NOT NULL,
  expires_at     timestamp(3),
  property       text,
  created_date   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
