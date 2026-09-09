// Save a project's analytics config — upserts .morpheus/analytics.json.
// Morpheus stores only the provider + public site token; the operator's own
// analytics account holds the data.
import { prisma } from '../db.js';
import { ANALYTICS_PATH, normalizeAnalytics, analyticsSnippet } from '../lib/projectAnalytics.js';

export default async function handler({ user, body }) {
  const { projectId, analytics } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const normalized = normalizeAnalytics(analytics);
  const content = JSON.stringify(normalized, null, 2);
  const existing = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: ANALYTICS_PATH } });
  if (existing) {
    await prisma.projectFile.update({ where: { id: existing.id }, data: { content } });
  } else {
    await prisma.projectFile.create({
      data: { project_id: projectId, created_by_id: user.id, path: ANALYTICS_PATH, content, language: 'json' },
    });
  }

  return { analytics: normalized, snippet: analyticsSnippet(normalized) };
}
