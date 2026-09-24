-- project_files.synced_sha — what a file looked like at the last sync.
--
-- WHY THIS EXISTS
--
-- SYNC FROM GITHUB is not a safe operation and the pipeline recommends it. While
-- an un-pushed change sits in the self-dev workspace, `importSelfDevRepo`:
--
--   * fetches and upserts over any local file whose git-blob sha differs from
--     upstream's, and
--   * deletes any local row whose path no longer exists upstream.
--
-- Both are right for a mirror catching up, and both destroy work in progress.
-- Demonstrated 2026-09-24: the H9 drift guard refused a stale push and told the
-- operator to SYNC and re-apply — running the sync deleted the new card file and
-- reverted the edit to cards.js, and the next push reported "no changes to
-- push". The advice cost exactly the work it told the operator to re-apply.
--
-- The reason it cannot tell the difference is provenance. "Local sha differs
-- from remote" describes BOTH "upstream moved on" (normal catch-up, must
-- overwrite) and "I edited this" (work in progress, must not). This column
-- records the upstream blob sha each local file was last synced from, which
-- separates the two:
--
--   local.content-sha != synced_sha        -> locally modified since the sync
--   local.content-sha == synced_sha        -> untouched; safe to overwrite
--   path absent upstream, synced_sha set   -> upstream deleted it; safe to drop
--   path absent upstream, synced_sha null  -> created locally; must not be lost
--
-- Additive and idempotent per KNOWN-HAZARDS.md H8. Nullable on purpose: every
-- existing row has no recorded provenance, and "unknown" must behave
-- conservatively rather than be treated as "unmodified". The column is applied to
-- production BEFORE the code that reads it ships, because a column Prisma's
-- generated client knows about and the database lacks is the H11 outage shape.

ALTER TABLE project_files
  ADD COLUMN IF NOT EXISTS synced_sha TEXT;

COMMENT ON COLUMN project_files.synced_sha IS
  'git blob sha of the upstream content this row was last synced from. NULL = provenance unknown (pre-dates this column, or a file created locally). Used by self-dev sync to tell an upstream change apart from un-pushed local work.';
