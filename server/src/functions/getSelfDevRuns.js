// Read back the self-dev run record — what the last runs actually did.
//
// The other half of lib/selfDevRuns.js. That module writes a row per pipeline
// stage; this is the only way to read them without a database client, which is
// what made the 2026-09-24 audit expensive: answering "what has self-dev
// actually been doing?" meant querying production tables by hand.
//
// Deliberately NOT admin-gated at the route level, matching
// getSelfDevFeatures.js/getSelfDevDecisions.js: it returns only rows belonging
// to the calling account, so a non-admin sees their own self-dev workspace or
// nothing. The operator token reaches it because it is on that allow-list, and
// the operator acts as the workspace's own owner.
import { prisma } from '../db.js';
import { recentRuns } from '../lib/selfDevRuns.js';

export async function runGetSelfDevRuns(user, { limit = 5 } = {}) {
  const project = await prisma.project.findFirst({
    where: { created_by_id: user.id, project_type: 'self_dev' },
    select: { id: true },
  });
  if (!project) throw Object.assign(new Error('Self-dev project not found'), { status: 404 });
  return recentRuns(user.id, limit);
}

export default async function handler({ user, body }) {
  if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  return runGetSelfDevRuns(user, { limit: body?.limit });
}
