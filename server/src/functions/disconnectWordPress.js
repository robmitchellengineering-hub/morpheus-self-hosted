// Forget the WordPress plugin connection for a project. The plugin itself
// keeps running on the site until the operator deactivates it there.
import { prisma } from '../db.js';
import { deleteWpConnection } from '../lib/wpPlugin.js';

export default async function handler({ user, body }) {
  const { projectId } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  await deleteWpConnection(projectId, user.id);
  return { connected: false };
}
