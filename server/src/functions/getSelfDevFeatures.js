// Read self-dev features for a project (SELF-DEV-V2 A1): the active one (if
// any) plus recent finished/abandoned ones. Returns { migrated, active, recent }
// — `migrated: false` when server/prisma/add-self-dev-features-table.sql hasn't
// been run yet, so the FEATURE panel can show a "run the migration" note
// instead of an error.
import { prisma } from '../db.js';
import { isMissingFeatureTable, hydrate } from '../lib/selfDevFeature.js';

export default async function handler({ user, body, query }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  try {
    const rows = await prisma.selfDevFeature.findMany({
      where: { project_id: projectId },
      orderBy: { created_date: 'desc' },
      take: 20,
    });
    const active = rows.find((r) => r.status === 'active') || null;
    const recent = rows.filter((r) => r.status !== 'active').slice(0, 8);
    return { migrated: true, active: hydrate(active), recent: recent.map(hydrate) };
  } catch (err) {
    if (isMissingFeatureTable(err)) return { migrated: false, active: null, recent: [] };
    throw err;
  }
}
