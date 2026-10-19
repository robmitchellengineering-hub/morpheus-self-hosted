// Pulls a project's mirrored Google Drive folder back into its ProjectFile
// rows — the read-side counterpart to pushProjectToDrive.js, and Drive's
// equivalent of syncProjectFromGithub.js (same incremental-diff shape,
// modifiedTime standing in for a git blob sha). Also the mechanism behind
// Rob's "fall back to whatever's cached automatically" decision: if this
// pull ever fails (revoked access, quota, network), the caller just keeps
// using whatever's already in Postgres — nothing here deletes local
// content on a failed pull, only on a successful listing that confirms a
// file is genuinely gone from Drive.
import { prisma } from '../db.js';
import { getGoogleDriveToken } from '../lib/googleDrive.js';
import { listDriveFolderFiles, getDriveFileContent } from '../lib/googleDrive.js';
import { detectLanguage, logUsage } from '../lib/projectUtils.js';

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export default async function handler({ user, body }) {
  const { projectId } = body;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!project.drive_folder_id) {
    throw Object.assign(new Error('This project has never been pushed to Drive yet.'), { status: 400 });
  }

  const token = await getGoogleDriveToken(user.id);
  const driveFiles = await listDriveFolderFiles(token, project.drive_folder_id);

  const localFiles = await prisma.projectFile.findMany({
    where: { project_id: projectId },
    select: { id: true, path: true, drive_file_id: true, drive_modified_time: true },
  });
  const localByDriveId = new Map(localFiles.filter((f) => f.drive_file_id).map((f) => [f.drive_file_id, f]));

  const toFetch = driveFiles.filter((f) => {
    const local = localByDriveId.get(f.id);
    return !local || !local.drive_modified_time || local.drive_modified_time.getTime() !== new Date(f.modifiedTime).getTime();
  });

  const fetched = await mapWithConcurrency(toFetch, 10, async (f) => {
    try {
      const content = await getDriveFileContent(token, f.id);
      // Decode the fraction-slash back to a real path separator — see
      // pushProjectToDrive.js's encoding comment.
      const path = f.name.replace(/⁄/g, '/');
      return { path, content, driveFileId: f.id, modifiedTime: f.modifiedTime };
    } catch {
      return null;
    }
  });
  const fetchedOk = fetched.filter(Boolean);
  const failed = fetched.length - fetchedOk.length;

  for (const f of fetchedOk) {
    await prisma.projectFile.upsert({
      where: { project_id_path: { project_id: projectId, path: f.path } },
      update: { content: f.content, language: detectLanguage(f.path), drive_file_id: f.driveFileId, drive_modified_time: new Date(f.modifiedTime) },
      create: { created_by_id: user.id, project_id: projectId, path: f.path, content: f.content, language: detectLanguage(f.path), drive_file_id: f.driveFileId, drive_modified_time: new Date(f.modifiedTime) },
    });
  }

  // Only remove a local row whose Drive file id we can positively confirm
  // no longer exists in the folder listing — a row with no drive_file_id
  // yet (never pushed) is left untouched, same caution as the "no data
  // loss on a failed pull" principle above.
  const stillPresentDriveIds = new Set(driveFiles.map((f) => f.id));
  const staleIds = localFiles.filter((f) => f.drive_file_id && !stillPresentDriveIds.has(f.drive_file_id)).map((f) => f.id);
  if (staleIds.length > 0) {
    await prisma.projectFile.deleteMany({ where: { id: { in: staleIds } } });
  }

  const fetchedCount = fetchedOk.length;
  await logUsage(user.id, 'project_pull_from_drive', project.id, project.name, {
    fileCount: driveFiles.length, fetched: fetchedCount, skipped: failed, removed: staleIds.length,
  });

  return {
    projectId,
    fileCount: driveFiles.length,
    fetched: fetchedCount,
    skipped: failed,
    removed: staleIds.length,
  };
}
