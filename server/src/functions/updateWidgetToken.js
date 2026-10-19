// Change an embeddable widget token's scopes in place, so the owner never has to
// mint a new token and re-paste the snippet to gain a tab.
//
// NOT widget-callable, by construction: the name appears in no scope's function
// allow-list (lib/widgetToken.js), so a widget token calling it is refused like
// any other unknown function. A credential must never be able to widen itself.
import { prisma } from '../db.js';
import { updateWidgetTokenScopes, isMissingWidgetTable } from '../lib/widgetToken.js';

export default async function handler({ user, body }) {
  const { projectId, tokenId, scopes } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!tokenId) throw Object.assign(new Error('tokenId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  try {
    return await updateWidgetTokenScopes(tokenId, projectId, user.id, scopes);
  } catch (err) {
    if (isMissingWidgetTable(err)) {
      throw Object.assign(new Error('Widget tokens table is not migrated yet — run add-widget-tokens.sql.'), { status: 503 });
    }
    throw err;
  }
}
