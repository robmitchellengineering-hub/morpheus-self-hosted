// The durable half of the compiled-artifact save (see lib/artifactSaveJob.js
// for the pure state machine and why the save moved off the request).
//
// WHY platform_settings AND NOT A NEW TABLE
//
// The record is the release's asset list, the per-asset progress, and the
// terminal verdict — the thing a poll must read on any replica, after any
// restart. The obvious home is a new `ArtifactSaveJob` table, and that is the
// wrong move here: this repo's migrations are hand-run SQL (KNOWN-HAZARDS.md
// H8), and the backend deploy only runs `prisma generate`. A new table would
// deploy baked into the code while the live database did not have it yet, so
// the save feature would break for every compile until someone ran the SQL by
// hand — H11's "you cannot assume the migration has been applied".
//
// platform_settings is the existing, already-migrated key/value store, and its
// own contract (server/src/routes/admin.routes.js) says any key is valid and
// "anything else is inert until a future feature reads it". The transient rows
// this writes are namespaced (`artifact_save_job:<projectId>`) and are read
// here with a direct query rather than through lib/platformSettings.js, whose
// 30s cache would make progress look stale. They carry no secrets — asset
// names, sizes, counts and error strings only.
import { prisma } from '../db.js';
import { ARTIFACT_SAVE_RECORD_PREFIX } from './artifactSaveJob.js';

export function artifactSaveJobKey(projectId) {
  return `${ARTIFACT_SAVE_RECORD_PREFIX}${projectId}`;
}

/**
 * Persist progress. A failed write must never kill the save — the next asset's
 * write (or the terminal one) is the one that matters, and the `_compiled/`
 * rows remain the durable per-asset evidence regardless.
 */
export async function writeArtifactSaveRecord(record) {
  if (!record?.projectId) return;
  try {
    const value = JSON.stringify(record);
    await prisma.platformSetting.upsert({
      where: { key: artifactSaveJobKey(record.projectId) },
      update: { value },
      create: { key: artifactSaveJobKey(record.projectId), value },
    });
  } catch (err) {
    console.error('[artifactSaveJob] progress write failed:', err?.message || err);
  }
}

/** The record for a project, or null when there is none / it cannot be read. */
export async function readArtifactSaveRecord(projectId) {
  if (!projectId) return null;
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: artifactSaveJobKey(projectId) } });
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Forget a finished record. Keeping one forever would leave a stale "saving"
 * record able to outlive its project; clearing it after the terminal state has
 * been observed is the only honest end. Deliberately best-effort: if this
 * fails, the staleness rule in artifactSaveJob.js still stops the record from
 * reading as a live save.
 */
export async function clearArtifactSaveRecord(projectId) {
  if (!projectId) return;
  try {
    await prisma.platformSetting.deleteMany({ where: { key: artifactSaveJobKey(projectId) } });
  } catch (err) {
    console.error('[artifactSaveJob] record clear failed:', err?.message || err);
  }
}
