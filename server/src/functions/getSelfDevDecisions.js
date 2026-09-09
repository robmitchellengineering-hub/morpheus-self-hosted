// Read a project's decisions log (originally self-dev Tier 2 #7, now every
// project). Returns { migrated, decisions } — migrated:false when
// server/prisma/add-self-dev-decisions-table.sql hasn't been run yet. Scoped
// to the caller's own project.
import { prisma } from '../db.js';
import { isMissingDecisionsTable } from '../lib/selfDevDecisions.js';

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  try {
    const decisions = await prisma.selfDevDecision.findMany({
      where: { project_id: projectId },
      orderBy: { created_date: 'desc' },
      take: 100,
    });
    return { migrated: true, decisions };
  } catch (err) {
    if (isMissingDecisionsTable(err)) return { migrated: false, decisions: [] };
    throw err;
  }
}
