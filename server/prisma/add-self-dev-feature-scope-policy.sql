-- Nullable scope-policy tag for self-dev features. Every existing/normal
-- feature stays null (today's unrestricted behavior, unchanged) — only a
-- feature created through a scoped build path (e.g. a Jarvis-triggered
-- Command Deck widget build) sets this, naming which enginePolicy.js policy
-- restricts what files that build may touch. Run on prod Supabase via the
-- SQL editor ("Run without RLS", as with every other Morpheus table —
-- Prisma direct connection, not PostgREST).

ALTER TABLE self_dev_features ADD COLUMN IF NOT EXISTS scope_policy text;
