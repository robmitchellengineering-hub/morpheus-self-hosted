-- Adds Gmail-sync support to deck_inbox_items: a dedup key so
-- syncDeckGmailInbox.js doesn't recreate the same message on every sync,
-- plus the sender's email address (needed to actually send a reply).
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table — Prisma direct connection, not PostgREST).

ALTER TABLE deck_inbox_items ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE deck_inbox_items ADD COLUMN IF NOT EXISTS from_email text;
