// Read the self-dev decisions log (Command Deck Tier 2 #7) for the DECISIONS
// tab in SelfDevHistoryModal. Returns { migrated, decisions } — migrated:false
// when server/prisma/add-self-dev-decisions-table.sql hasn't been run yet.
import { prisma } from '../db.js';
import { isMissingDecisionsTable } from '../lib/selfDevDecisions.js';

export default async function handler({ user, body, query }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

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
