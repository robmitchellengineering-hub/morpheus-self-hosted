-- Jarvis's real long-term memory — see schema.prisma's comment above
-- DeckJarvisMemory. Run on prod Supabase via the SQL editor ("Run without
-- RLS", as with every other Morpheus table — Prisma direct connection, not
-- PostgREST).

CREATE TABLE IF NOT EXISTS deck_jarvis_memory (
  id                    text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id         text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  content               text NOT NULL,
  folded_message_count  integer NOT NULL DEFAULT 0,
  created_date          timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date          timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
