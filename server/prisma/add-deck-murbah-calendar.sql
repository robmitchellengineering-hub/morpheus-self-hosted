-- Calendar sync for Murbah opportunities — see schema.prisma's comment
-- above DeckMurbahOpportunity's booking_date/calendar_event_id fields. Run
-- on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table — Prisma direct connection, not PostgREST).

ALTER TABLE deck_murbah_opportunities ADD COLUMN IF NOT EXISTS booking_date timestamp(3);
ALTER TABLE deck_murbah_opportunities ADD COLUMN IF NOT EXISTS calendar_event_id text;
