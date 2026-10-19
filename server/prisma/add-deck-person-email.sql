-- People get an email field alongside phone, so a task can be texted or
-- emailed straight to whoever owns it. Run on prod Supabase via the SQL
-- editor ("Run without RLS", as with every other Morpheus table — Prisma
-- direct connection, not PostgREST).

ALTER TABLE deck_people ADD COLUMN IF NOT EXISTS email text;
