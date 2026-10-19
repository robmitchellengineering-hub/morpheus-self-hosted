-- WidgetToken — an embeddable-widget access token, scoped to one project.
-- Full token (wgt_<hex>) shown once; only its SHA-256 is stored.
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table — Prisma direct connection, not PostgREST).

CREATE TABLE IF NOT EXISTS widget_tokens (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_prefix  text NOT NULL,
  token_hash    text NOT NULL,
  label         text,
  scopes        text NOT NULL DEFAULT 'chat,deploy,store',
  revoked       boolean NOT NULL DEFAULT false,
  last_used_at  timestamp(3),
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS widget_tokens_token_hash_key ON widget_tokens (token_hash);
CREATE INDEX IF NOT EXISTS widget_tokens_project_id_idx ON widget_tokens (project_id);
