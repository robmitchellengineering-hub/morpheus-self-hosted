-- Adds forward-to-Jarvis capture to deck_inbox_items: a tag recording which
-- forward address a message arrived via ("jarvis" or "build"), null for normal
-- inquiry items. Run on prod Supabase via the SQL editor ("Run without RLS",
-- as with every other Morpheus table — Prisma direct connection, not PostgREST).

ALTER TABLE deck_inbox_items ADD COLUMN IF NOT EXISTS forward_tag text;
