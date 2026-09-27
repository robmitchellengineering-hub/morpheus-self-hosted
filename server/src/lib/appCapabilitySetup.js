// Read a project's provider-setup verdict for a UI.
//
// WHY THIS IS ITS OWN MODULE: the compile UI must show the SAME two messages the
// app's README carries, and the failure mode to avoid is a second copy of the
// prose that drifts. Both are built by lib/appCapability.js's `buildProviderReport`
// from the same inputs, and this is the one function that assembles those inputs
// from the database — so the README write (functions/chatWithMorpheus.js) and the
// compile panel differ only in what they do with the result.
import { prisma } from '../db.js';
import { buildProviderReport } from './appCapability.js';
import { decodeConnections, netlifyOrigin } from './connectionSecrets.js';

/**
 * @returns {Promise<object>} the report from buildProviderReport, plus the app's
 *   app_id when it is worth quoting (a capability the operator can actually grant).
 */
export async function readProviderSetup(projectId, userId) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: userId },
    select: { id: true, name: true, compile_target: true },
  });
  if (!project) return null;

  const files = await prisma.projectFile.findMany({ where: { project_id: projectId }, select: { path: true, content: true } });

  // The app's real deployed origin, when it has one: mode B's steps are useless
  // without it, and "copy it from the address bar" is the honest fallback rather
  // than a URL guessed from the project name.
  let origin = '';
  try {
    const settings = await prisma.userSettings.findUnique({ where: { created_by_id: userId }, select: { connections: true } });
    origin = netlifyOrigin(decodeConnections(settings?.connections));
  } catch { origin = ''; }

  return buildProviderReport({
    files,
    compileTarget: project.compile_target,
    projectName: project.name,
    origin,
    originKnown: Boolean(origin),
  });
}
