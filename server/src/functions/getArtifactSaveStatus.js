// Poll the state of a compiled-artifact save that is running (or has finished)
// as a background job — see functions/saveCompiledArtifacts.js for why it moved
// off the request, and lib/artifactSaveJob.js for the phases.
//
// The whole point is that this can reconstruct the state AFTER A PAGE RELOAD,
// from durable evidence rather than the panel's memory:
//   * the `_compiled/<name>` ProjectFile rows processAsset writes as each asset
//     lands (the download links themselves), and
//   * the namespaced platform_settings record holding the release's asset list,
//     the per-asset progress and the terminal verdict.
// So it answers honestly on any replica and after a backend restart. A record
// stuck on "saving" past the staleness bound is reported as `interrupted`, never
// as still-saving and never as done.
import { prisma } from '../db.js';
import { artifactSaveResponse, ARTIFACT_SAVE_RECORD_TTL_MS } from '../lib/artifactSaveJob.js';
import { readArtifactSaveRecord, clearArtifactSaveRecord } from '../lib/artifactSaveJobStore.js';

export default async function handler({ user, body }) {
  const projectId = body?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const savedRows = (await prisma.projectFile.findMany({
    where: { project_id: projectId, created_by_id: user.id },
    select: { path: true, content: true, file_url: true, created_date: true },
    orderBy: { created_date: 'asc' },
  })).filter((f) => f.path.startsWith('_compiled/'));

  const record = await readArtifactSaveRecord(projectId);
  const response = artifactSaveResponse({ record, savedRows });

  // Bounded retention: once a record is settled AND old enough that no panel can
  // still be polling it, drop the row instead of leaving one per project in
  // platform_settings forever. A stale "saving" record reports `interrupted`, so
  // it is settled too. The `_compiled/` rows are the durable record either way.
  if (record && response.phase !== 'saving'
    && Date.now() - (record.finishedAt || record.updatedAt || record.startedAt || 0) > ARTIFACT_SAVE_RECORD_TTL_MS) {
    await clearArtifactSaveRecord(projectId);
  }

  return response;
}
