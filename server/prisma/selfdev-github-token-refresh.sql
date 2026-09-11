-- idempotent DDL for github token refresh expiry tracking
ALTER TABLE github_connections ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE github_connections ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ;
