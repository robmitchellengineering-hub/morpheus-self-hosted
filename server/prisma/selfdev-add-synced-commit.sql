-- Add Project.synced_commit — the branch HEAD a self-dev workspace was last
-- synced (or pushed) from, so a push can refuse to run against a stale mirror.
--
-- Additive and idempotent, per KNOWN-HAZARDS.md H8: this ships in the same
-- change as the schema.prisma edit, and is safe to re-run.
--
-- Context — incident H9 (2026-09-11): shipChange() diffs the local workspace
-- against the LIVE remote tree and treats every remote path absent locally as a
-- deletion. A workspace that fell behind main therefore does not merely miss
-- upstream work, it DELETES it. That incident removed ~45 files from production,
-- including a shipped security fix (blockWidget).
--
-- Nullable on purpose: existing workspaces have no recorded sync point, and the
-- code treats null as "unknown, fall back to the deletion-shape check".

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS synced_commit TEXT;

COMMENT ON COLUMN projects.synced_commit IS
  'Commit SHA of the branch this project''s file mirror was last synced from or pushed to. Used by self-dev''s H9 drift guard.';
