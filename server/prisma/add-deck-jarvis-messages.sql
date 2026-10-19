-- Command Deck — Jarvis persona (later phase). Adds the one new table for
-- Jarvis's plain conversational log. See schema.prisma's comment above
-- DeckJarvisMessage for why this isn't just reusing ChatMessage.
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table — Prisma direct connection, not PostgREST).

CREATE TABLE IF NOT EXISTS deck_jarvis_messages (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL,
  content       text NOT NULL,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_jarvis_messages_created_by_id_idx ON deck_jarvis_messages (created_by_id);
