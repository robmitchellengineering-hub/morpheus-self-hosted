-- Per-construct GitHub token (encrypted at rest, src/crypto.js). For client
-- work whose repo isn't covered by the owner's global GitHub connection —
-- a fine-grained PAT scoped to that one repo, stored on the project.
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table).

ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_token text;
