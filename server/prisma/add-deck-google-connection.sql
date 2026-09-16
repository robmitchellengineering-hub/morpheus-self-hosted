-- Command Deck's own Google connection (Gmail sync, Calendar sync, a
-- Deck-specific Drive backup, and Jarvis-driven Doc creation) — deliberately
-- separate from google_drive_connections (unrelated Project file storage,
-- Feature Backlog #12). See schema.prisma's comment above DeckGoogleConnection.
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table — Prisma direct connection, not PostgREST).

CREATE TABLE IF NOT EXISTS deck_google_connections (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  google_email  text NOT NULL,
  access_token  text NOT NULL,
  scope         text,
  refresh_token text NOT NULL,
  expires_at    timestamp(3),
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
