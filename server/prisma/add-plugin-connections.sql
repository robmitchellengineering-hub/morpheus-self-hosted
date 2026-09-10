-- PluginConnection — { site URL, shared signing secret } for a Morpheus
-- WordPress plugin on the operator's own site. Secret encrypted at rest.
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table — Prisma direct connection, not PostgREST).

CREATE TABLE IF NOT EXISTS plugin_connections (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id     text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'wordpress',
  site_url       text NOT NULL,
  webhook_secret text NOT NULL,
  repo           text,
  meta           text,
  created_date   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_connections_project_id_kind_key
  ON plugin_connections (project_id, kind);
