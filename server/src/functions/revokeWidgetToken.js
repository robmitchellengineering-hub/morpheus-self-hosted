// Revoke one embeddable-widget token. The embed stops working immediately.
import { prisma } from '../db.js';
import { revokeWidgetToken } from '../lib/widgetToken.js';

export default async function handler({ user, body }) {
  const { projectId, tokenId } = body || {};
  if (!projectId || !tokenId) throw Object.assign(new Error('projectId and tokenId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  return revokeWidgetToken(tokenId, projectId, user.id);
}
