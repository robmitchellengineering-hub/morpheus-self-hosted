// Ported from base44/functions/getBuildLogs/entry.ts.
import { prisma } from '../db.js';
import { aggregateBuildLogs } from '../lib/buildLogs.js';

export default async function handler({ user, body }) {
  const { projectId } = body;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const logs = await aggregateBuildLogs(user.id, projectId);

  return { logs, projectName: project.name, totalEvents: logs.length };
}
