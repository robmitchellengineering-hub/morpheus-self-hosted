-- Tracks every Gmail message id syncDeckGmailInbox.js has already
-- classified (inquiry or not), so re-syncing doesn't re-run the AI
-- classifier — and its cost — on the same newsletter every time.
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table — Prisma direct connection, not PostgREST).

CREATE TABLE IF NOT EXISTS deck_gmail_seen_messages (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id   text NOT NULL,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (created_by_id, external_id)
);
