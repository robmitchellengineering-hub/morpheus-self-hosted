// Switches a project's storage_mode. Deliberately a dedicated function
// rather than letting the generic entity-update endpoint handle it (the
// way e.g. polish_ui is toggled) — unlike that field, this one has a real
// precondition (a connected GoogleDriveConnection) and a real side effect
// (an initial push) the first time a project switches to "drive".
import { prisma } from '../db.js';
import { getGoogleDriveConnection, pushProjectFilesToDrive } from '../lib/googleDrive.js';

const VALID_MODES = new Set(['postgres', 'drive']);

export default async function handler({ user, body }) {
  const { projectId, storageMode } = body;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!VALID_MODES.has(storageMode)) {
    throw Object.assign(new Error(`storageMode must be one of: ${[...VALID_MODES].join(', ')}`), { status: 400 });
  }

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  if (storageMode === 'drive') {
    const connection = await getGoogleDriveConnection(user.id);
    if (!connection) {
      throw Object.assign(new Error('Connect Google Drive in Settings before switching a project to Drive storage.'), { status: 400 });
    }
  }

  await prisma.project.update({ where: { id: projectId }, data: { storage_mode: storageMode } });

  // Postgres already holds full content regardless of mode in this phase,
  // so switching back to "postgres" needs nothing further. Switching to
  // "drive" does an initial push so the Drive mirror isn't empty until the
  // user thinks to click Push themselves.
  let pushResult = null;
  if (storageMode === 'drive') {
    pushResult = await pushProjectFilesToDrive(user, project);
  }

  return { projectId, storageMode, push: pushResult };
}
