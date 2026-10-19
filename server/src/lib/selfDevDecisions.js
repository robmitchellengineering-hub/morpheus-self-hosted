// Self-dev decisions log (Command Deck Tier 2 #7). Helpers for the
// SelfDevDecision model — the pre-migration compat check, recording an entry,
// stamping the PR/commit ref once a change lands, and formatting the recent
// entries for the planner's context.
import { prisma } from '../db.js';

// The self_dev_decisions table ships ahead of its migration (like
// self_dev_features — see lib/selfDevFeature.js). Any Prisma call on the model
// throws until server/prisma/add-self-dev-decisions-table.sql is run. Detect
// that so self-dev keeps working and the log just stays empty.
export function isMissingDecisionsTable(err) {
  const m = err && typeof err.message === 'string' ? err.message : '';
  return err?.code === 'P2021'
    || /relation\s+"?self_dev_decisions"?\s+does not exist/i.test(m)
    || /table\s+.*self_dev_decisions.*does not exist/i.test(m)
    || /Cannot read properties of undefined \(reading '(find|create|update|delete|count)/i.test(m);
}

export async function recordDecision(userId, projectId, summary, rationale) {
  const s = String(summary || '').trim();
  const r = String(rationale || '').trim();
  if (!s) return null;
  try {
    return await prisma.selfDevDecision.create({
      data: { created_by_id: userId, project_id: projectId, summary: s.slice(0, 2000), rationale: (r || '—').slice(0, 2000) },
    });
  } catch (err) {
    if (isMissingDecisionsTable(err)) return null;
    console.error('[selfDevDecisions] recordDecision failed:', err.message);
    return null;
  }
}

// After a change lands, stamp `ref` on this project's decisions that don't have
// one yet — so the log shows which PR/commit shipped each decision.
export async function stampDecisionRef(projectId, ref) {
  if (!projectId || !ref) return;
  try {
    await prisma.selfDevDecision.updateMany({
      where: { project_id: projectId, ref: null },
      data: { ref: String(ref).slice(0, 120) },
    });
  } catch (err) {
    if (!isMissingDecisionsTable(err)) console.error('[selfDevDecisions] stampDecisionRef failed:', err.message);
  }
}

// The block handed to the planner on a self-dev build turn.
export async function recentDecisionsBlock(projectId, limit = 8) {
  let rows;
  try {
    rows = await prisma.selfDevDecision.findMany({
      where: { project_id: projectId },
      orderBy: { created_date: 'desc' },
      take: limit,
    });
  } catch (err) {
    if (isMissingDecisionsTable(err)) return '';
    throw err;
  }
  if (!rows || rows.length === 0) return '';
  const lines = rows
    .reverse()
    .map((d) => `- ${d.summary}${d.rationale && d.rationale !== '—' ? ` — ${d.rationale}` : ''}${d.ref ? ` (${d.ref})` : ''}`);
  return `
RECENT DECISIONS (what past self-dev changes did and why — build on these, don't contradict or redo them):
${lines.join('\n')}
`;
}
