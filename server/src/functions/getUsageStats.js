// Ported from base44/functions/getUsageStats/entry.ts.
import { prisma } from '../db.js';
import { estimateActionCost } from '../lib/costEstimate.js';

export default async function handler({ user }) {
  const records = await prisma.usageRecord.findMany({
    where: { created_by_id: user.id },
    orderBy: { created_date: 'desc' },
    take: 500,
  });

  const byType = {};
  let totalCredits = 0;
  let totalActions = 0;
  let totalUsd = 0;
  let platformUsd = 0;
  let customUsd = 0;

  for (const r of records) {
    if (!byType[r.action_type]) byType[r.action_type] = { count: 0, credits: 0, usd: 0 };
    byType[r.action_type].count++;
    byType[r.action_type].credits += r.credits || 0;

    const usd = estimateActionCost(r.action_type, r.metadata || '');
    byType[r.action_type].usd += usd;
    totalUsd += usd;

    let provider = 'platform';
    if (r.metadata) {
      try {
        const parsed = JSON.parse(r.metadata);
        if (parsed.provider === 'custom') provider = 'custom';
      } catch {
        // fall through — treat unparsable metadata as platform
      }
    }
    if (provider === 'custom') customUsd += usd;
    else platformUsd += usd;

    totalCredits += r.credits || 0;
    totalActions++;
  }

    // The original base44 UsagePanel's "recent activity" list reads a `recent`
    // field (last 20 usage records) that this port never returned, so it had
    // no data source. `records` is already ordered desc by created_date, so
    // the first 20 are the most recent.
    const recent = records.slice(0, 20).map((r) => ({
          id: r.id,
          action_type: r.action_type,
          credits: r.credits || 0,
          usd: Number(estimateActionCost(r.action_type, r.metadata || '').toFixed(4)),
          created_date: r.created_date,
          project_name: r.project_name || undefined,
    }));

  return {
    byType,
    totalCredits,
    totalActions,
    totalUsd: Number(totalUsd.toFixed(4)),
    platformUsd: Number(platformUsd.toFixed(4)),
    customUsd: Number(customUsd.toFixed(4)),
        recent,
  };
}
