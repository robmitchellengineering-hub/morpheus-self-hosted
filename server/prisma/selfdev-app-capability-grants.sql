-- app_capability_grants — a user's one-time approval that ONE generated app may
-- use ONE named capability (today only `drive_upload`) against that user's own
-- Google Drive connection.
--
-- WHY THIS IS A NEW TABLE
--
-- The owner's decision, 2026-09-28, verbatim: "I think we need to make morpheus as
-- a whole handle oauth and credentials like this so it will just work for free
-- tier app creation or if it needs to be the other way he needs to say so and let
-- people know the steps."
--
-- A generated app lives on another origin with no Morpheus session, so it needs a
-- token of its own. The shape is lib/widgetToken.js's — prefix, sha256 hash at
-- rest, revoked flag, last_used_at — and it is a separate table because the grant
-- is resolved by one purpose-built endpoint that checks an `app_id` the caller
-- NAMES against the one folded into the row. That makes "a token for app A cannot
-- act on app B" a checked fact rather than a consequence of the widget dispatcher
-- pinning a body field, and it keeps app capabilities in their own namespace
-- instead of overloading WIDGET_SCOPE_FUNCTIONS, which names Morpheus functions.
--
-- Additive and idempotent, per KNOWN-HAZARDS.md H8. NOT APPLIED by the change that
-- ships it — and deliberately safe if it lands after the code does: only the
-- capability endpoint reads this table, and lib/appCapabilityGrants.js reports a
-- missing table as "not set up yet" (503) rather than throwing, so an unmigrated
-- database cannot break any other page. That is the H11 shape with the smallest
-- possible blast radius, because entities.js never lists this model.
--
-- The foreign keys are written INSIDE the CREATE TABLE rather than as separate
-- `ALTER TABLE … ADD CONSTRAINT` statements on purpose. `ADD CONSTRAINT` is not
-- idempotent (Postgres has no IF NOT EXISTS for it), so a re-run would fail
-- halfway — which is exactly what H8's "idempotent" requirement rules out, and
-- what lib/selfDevMigrations.js's additive-only applier would otherwise have to
-- hand to a human. Inline, the whole file is one statement that is safe twice.
--
-- The token itself is NEVER stored. Only its SHA-256 is, which is why the token is
-- shown exactly once at creation and cannot be recovered from this database.

CREATE TABLE IF NOT EXISTS app_capability_grants (
    id            TEXT        NOT NULL,
    created_by_id TEXT        NOT NULL,
    project_id    TEXT        NOT NULL,
    app_id        TEXT        NOT NULL,
    token_prefix  TEXT        NOT NULL,
    token_hash    TEXT        NOT NULL,
    label         TEXT,
    capabilities  TEXT        NOT NULL,
    revoked       BOOLEAN     NOT NULL DEFAULT false,
    last_used_at  TIMESTAMP(3),
    created_date  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT app_capability_grants_pkey PRIMARY KEY (id),
    CONSTRAINT app_capability_grants_created_by_id_fkey FOREIGN KEY (created_by_id)
      REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT app_capability_grants_project_id_fkey FOREIGN KEY (project_id)
      REFERENCES projects (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS app_capability_grants_token_hash_key
  ON app_capability_grants (token_hash);

CREATE INDEX IF NOT EXISTS app_capability_grants_project_id_idx
  ON app_capability_grants (project_id);

CREATE INDEX IF NOT EXISTS app_capability_grants_created_by_id_idx
  ON app_capability_grants (created_by_id);

COMMENT ON TABLE app_capability_grants IS
  'One user''s approval that one generated app may use one named capability against that user''s own Google Drive connection. token_hash is sha256(full token); the token itself is never stored, so it is shown once at creation. Resolved by routes/appCapability.routes.js, which checks the app_id the caller names against this row.';

COMMENT ON COLUMN app_capability_grants.app_id IS
  'Derived from the project id (lib/appCapability.js appIdForProject). Quoted by the app on every request and compared constant-time against this row, so a token minted for one app cannot act for another. Not a secret.';

COMMENT ON COLUMN app_capability_grants.capabilities IS
  'Comma-separated names from APP_CAPABILITIES in lib/appCapability.js. Unknown names are dropped at creation, so a row can only carry a capability the endpoint would accept.';
