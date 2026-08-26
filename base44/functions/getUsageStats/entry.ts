import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { estimateActionCost } from '../../shared/costEstimate.ts';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const records = await base44.entities.UsageRecord.list('-created_date', 500);

    const byType: Record<string, { count: number; credits: number; usd: number }> = {};
    let totalCredits = 0;
    let totalActions = 0;
    let totalUsd = 0;
    let platformUsd = 0;
    let customUsd = 0;
    const recent: any[] = [];

    for (const r of records) {
      if (!byType[r.action_type]) byType[r.action_type] = { count: 0, credits: 0, usd: 0 };
      byType[r.action_type].count++;
      byType[r.action_type].credits += r.credits || 0;

      const usd = estimateActionCost(r.action_type, r.metadata || '');
      byType[r.action_type].usd += usd;
      totalUsd += usd;

      // Determine provider from metadata for platform/custom split
      let provider = 'platform';
      if (r.metadata) {
        try {
          const parsed = JSON.parse(r.metadata);
          if (parsed.provider === 'custom') { provider = 'custom'; customUsd += usd; }
          else { platformUsd += usd; }
        } catch {
          platformUsd += usd;
        }
      } else {
        platformUsd += usd;
      }

      totalCredits += r.credits || 0;
      totalActions++;
      if (recent.length < 20) {
        recent.push({
          action_type: r.action_type,
          credits: r.credits,
          usd: Number(usd.toFixed(4)),
          project_name: r.project_name || '',
          created_date: r.created_date,
          metadata: r.metadata || ''
        });
      }
    }

    return Response.json({
      byType,
      totalCredits,
      totalActions,
      totalUsd: Number(totalUsd.toFixed(4)),
      platformUsd: Number(platformUsd.toFixed(4)),
      customUsd: Number(customUsd.toFixed(4))
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}