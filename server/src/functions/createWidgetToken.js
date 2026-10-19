// Mint an embeddable-widget token for a project the caller owns. The full
// token is returned ONCE — the caller pastes it into the embed snippet.
import { prisma } from '../db.js';
import { createWidgetToken, isMissingWidgetTable } from '../lib/widgetToken.js';

export default async function handler({ user, body }) {
  const { projectId, label, scopes } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  try {
    return await createWidgetToken(projectId, user.id, { label, scopes });
  } catch (err) {
    if (isMissingWidgetTable(err)) {
      throw Object.assign(new Error('Widget tokens table is not migrated yet — run add-widget-tokens.sql.'), { status: 503 });
    }
    throw err;
  }
}
