// List a project's embeddable-widget tokens (prefix + label + scopes +
// state — never the secret).
import { prisma } from '../db.js';
import { listWidgetTokens } from '../lib/widgetToken.js';

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  return { tokens: await listWidgetTokens(projectId, user.id) };
}
