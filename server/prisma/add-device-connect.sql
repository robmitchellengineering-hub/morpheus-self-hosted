-- Morpheus Connect — device login for native/compiled apps (e.g. Construct's
-- Wikidata Batch Uploader). See schema.prisma's DeviceAuthRequest/DeviceToken
-- comment and server/src/lib/deviceToken.js for the full design.
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table — Prisma direct connection, not PostgREST).

CREATE TABLE IF NOT EXISTS device_auth_requests (
  id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  device_code       text NOT NULL,
  user_code         text NOT NULL,
  client_label      text NOT NULL,
  scopes            text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  approved_by_id    text,
  issued_token_id   text,
  pending_token     text,
  expires_at        timestamp(3) NOT NULL,
  created_date      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS device_auth_requests_device_code_key ON device_auth_requests (device_code);
CREATE UNIQUE INDEX IF NOT EXISTS device_auth_requests_user_code_key ON device_auth_requests (user_code);

CREATE TABLE IF NOT EXISTS device_tokens (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         text NOT NULL,
  token_prefix  text NOT NULL,
  token_hash    text NOT NULL,
  scopes        text NOT NULL,
  revoked       boolean NOT NULL DEFAULT false,
  last_used_at  timestamp(3),
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS device_tokens_token_hash_key ON device_tokens (token_hash);
CREATE INDEX IF NOT EXISTS device_tokens_created_by_id_idx ON device_tokens (created_by_id);
