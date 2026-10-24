-- Valiant Verification (VDS certification) subscriptions.
-- Hand-run against the database, per the repo's migration convention (H8 —
-- there is no prisma/migrations directory). Safe to run more than once.
CREATE TABLE IF NOT EXISTS verification_subscriptions (
  id                     TEXT PRIMARY KEY,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  package                TEXT NOT NULL,
  seats                  INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'active',
  customer_email         TEXT,
  current_period_end     TIMESTAMPTZ,
  created_date           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS verification_subscriptions_status_idx
  ON verification_subscriptions (status);
