// Read-only: the last N chat turns for a project. Exists for a surface
// that wants to *show* the conversation without running a build turn — the
// embed widget's dock, specifically: chatWithMorpheus.js already saves
// every turn and re-loads recent history as model context on every call,
// so Morpheus's own memory of a conversation survives a page navigation
// even though (until this) the widget's on-screen transcript didn't — the
// iframe gets rebuilt from scratch on every full page load and had no way
// to ask for what came before.
import { prisma } from '../db.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const requested = parseInt(body?.limit ?? query?.limit, 10);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_LIMIT));

  const rows = await prisma.chatMessage.findMany({
    where: { project_id: projectId },
    orderBy: { created_date: 'desc' },
    take: limit,
    select: { id: true, role: true, content: true, created_date: true },
  });

  return { messages: rows.reverse() };
}
