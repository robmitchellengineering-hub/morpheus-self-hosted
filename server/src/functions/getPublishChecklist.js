// The PUBLISH panel's data — the current project's publish-readiness checklist
// for its compile target, each item marked done/missing against the files.
import { prisma } from '../db.js';
import { evaluatePublishChecklist } from '../lib/publishChecklist.js';

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const files = await prisma.projectFile.findMany({
    where: { project_id: projectId },
    select: { path: true, content: true },
  });

  const target = project.compile_target || 'source';
  const result = evaluatePublishChecklist(target, files);
  return { target, ...result };
}
