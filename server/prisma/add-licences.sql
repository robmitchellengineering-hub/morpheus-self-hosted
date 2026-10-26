-- Licences: the credential a paying customer holds for the Valiant Verification SDK.
-- Additive, in the same shape as the other add-*.sql files in this directory.
--
-- WHY A TABLE AND NOT A FLAG: Rob's design is that Morpheus ISSUES the licence under the buyer's own
-- account and gives him a private page to see and revoke them. That needs a row per licence — account,
-- plan, seats, expiry, the signing key id (so a rotation does not invalidate everything at once) and a
-- revocable state. The signed token is GENERATED from these fields and never stored: a stolen table
-- dump yields no working licence without the private key, which never leaves the issuer's machine.
--
-- created_by_id is `text`, not `uuid`: Prisma maps `String @id @default(uuid())` to text. Checked
-- against the live column (information_schema) rather than assumed — a uuid FK here would have failed
-- at apply time, in production, on a schema change.
CREATE TABLE IF NOT EXISTS licences (
  id            text PRIMARY KEY,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jti           text NOT NULL UNIQUE,
  plan          text NOT NULL,
  seats         integer NOT NULL DEFAULT 1,
  kid           text NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  note          text,
  created_date  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS licences_created_by_id_idx ON licences (created_by_id);
