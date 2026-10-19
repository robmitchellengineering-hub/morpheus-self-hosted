// Read a project's analytics config (.morpheus/analytics.json) + the
// provider catalogue for the panel.
import { prisma } from '../db.js';
import { ANALYTICS_PATH, ANALYTICS_PROVIDERS, normalizeAnalytics, analyticsSnippet } from '../lib/projectAnalytics.js';

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const row = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: ANALYTICS_PATH } });
  let analytics = { provider: '' };
  if (row?.content) {
    try { analytics = normalizeAnalytics(JSON.parse(row.content)); } catch { /* corrupt — none */ }
  }

  return {
    analytics,
    providers: ANALYTICS_PROVIDERS,
    snippet: analyticsSnippet(analytics),
    isWeb: (project.compile_target || 'source') === 'web-app',
  };
}
