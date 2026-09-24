// The database half of sync safety — reading and writing per-file provenance.
//
// Split from lib/selfDevSyncSafety.js, which holds the rules and imports nothing
// but the blob hash: a script in CI's `guards (no install)` job has to be able to
// test the decision that protects someone's work, and it cannot reach Prisma.
//
// The asymmetry between the two events is the whole design:
//
//   SYNC   writes the upstream sha for every file it touches, so the NEXT sync
//          can tell "upstream moved on" from "I edited this".
//   PUSH   (direct) and MERGE write the local content's own sha, because after
//          either one upstream holds exactly what is here — leaving stale
//          provenance would make the next sync read every shipped file as
//          locally modified and refuse. A false positive that blocks the normal
//          push → sync rhythm would be worse than the bug being fixed.
//
// A pull request is deliberately NOT one of those points: until it merges,
// upstream does not have the change, so the local copy genuinely is un-pushed
// work and a sync refusing to overwrite it is correct.
import { prisma } from '../db.js';
import { gitBlobSha } from './selfDevRepo.js';

/** Provenance for every row of a project, as path → sha|null. */
export async function readProvenance(projectId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      'select path, synced_sha from project_files where project_id = $1',
      projectId,
    );
    return new Map(rows.map((r) => [r.path, r.synced_sha ?? null]));
  } catch (err) {
    // The column ships ahead of its migration on an un-updated deployment. No
    // provenance is survivable — the assessor's conservative rules still protect
    // orphaned files — so this degrades instead of failing the sync.
    console.warn('[selfDevSync] provenance unavailable, treating every row as unknown:', err?.message || err);
    return new Map();
  }
}

/**
 * Record provenance for a set of paths in one statement.
 *
 * One UPDATE rather than N upserts: a full sync touches ~900 files and a
 * per-row loop is 900 round trips. `unnest` keeps it a single statement without
 * depending on pgcrypto to recompute git's blob hash inside Postgres.
 *
 * @param {string} projectId
 * @param {Array<{path: string, sha: string}>} entries
 */
export async function recordProvenance(projectId, entries) {
  const rows = (entries || []).filter((e) => e?.path && e?.sha);
  if (!rows.length) return 0;
  const paths = rows.map((r) => r.path);
  const shas = rows.map((r) => r.sha);
  try {
    await prisma.$executeRawUnsafe(
      `update project_files as pf set synced_sha = v.sha
         from (select unnest($1::text[]) as path, unnest($2::text[]) as sha) v
        where pf.project_id = $3 and pf.path = v.path`,
      paths, shas, projectId,
    );
    return rows.length;
  } catch (err) {
    console.warn('[selfDevSync] could not record provenance:', err?.message || err);
    return 0;
  }
}

/**
 * After a direct push or a merge, upstream holds exactly what is in the
 * workspace — so every file's provenance becomes its own content hash.
 *
 * Best-effort by design: this runs after the work has already succeeded, and
 * failing to write provenance must never turn a successful push into an error.
 * The cost of failure is one spurious refusal at the next sync, which the
 * operator can clear with acceptLocalLoss; the cost of throwing here would be a
 * push that worked reporting that it did not.
 */
export async function markWorkspaceSynced(projectId) {
  try {
    const files = await prisma.projectFile.findMany({
      where: { project_id: projectId },
      select: { path: true, content: true },
    });
    return await recordProvenance(projectId, files.map((f) => ({ path: f.path, sha: gitBlobSha(f.content ?? '') })));
  } catch (err) {
    console.warn('[selfDevSync] could not mark the workspace synced:', err?.message || err);
    return 0;
  }
}
