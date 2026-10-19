// Bootstrap for the embeddable-widget surface (/embed): what project this
// widget token is bound to, its scopes, and enough to render. Only callable
// with a widget token (req.widget set by optionalAuth).
import { prisma } from '../db.js';

export default async function handler({ user, req }) {
  const w = req?.widget;
  if (!w) throw Object.assign(new Error('This endpoint is for widget tokens only.'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: w.projectId, created_by_id: user.id },
    select: { id: true, name: true, compile_target: true },
  });
  if (!project) throw Object.assign(new Error('The project this widget points to is gone.'), { status: 404 });

  return {
    projectId: project.id,
    projectName: project.name,
    compileTarget: project.compile_target,
    scopes: w.scopes,
  };
}
