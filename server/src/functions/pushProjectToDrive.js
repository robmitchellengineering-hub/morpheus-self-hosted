// Pushes a project's current files up to its mirrored Google Drive folder.
// Thin endpoint wrapper — the actual logic (also used by
// setProjectStorageMode.js's initial push) lives in lib/googleDrive.js's
// pushProjectFilesToDrive.
import { prisma } from '../db.js';
import { pushProjectFilesToDrive } from '../lib/googleDrive.js';

export default async function handler({ user, body }) {
  const { projectId } = body;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  return pushProjectFilesToDrive(user, project);
}
