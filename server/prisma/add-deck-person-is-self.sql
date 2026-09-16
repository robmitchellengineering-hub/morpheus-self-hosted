-- The "me" person becomes a stable identity marker instead of a literal
-- name match, so it can be renamed to the user's real name and brain dump's
-- first-person ("I") detection can find it reliably. Backfills existing
-- rows seeded with the old literal "You" name. Run on prod Supabase via
-- the SQL editor ("Run without RLS", as with every other Morpheus table —
-- Prisma direct connection, not PostgREST).

ALTER TABLE deck_people ADD COLUMN IF NOT EXISTS is_self boolean NOT NULL DEFAULT false;
UPDATE deck_people SET is_self = true WHERE lower(name) = 'you';
