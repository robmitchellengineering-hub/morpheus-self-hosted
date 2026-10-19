// New — not a base44 port, but modeled directly on base44's live admin-only
// "MORPHEUS UPDATES PLAN" tool description: "synthesizes every
// user-submitted issue and feature request into a single prioritized,
// actionable plan — ranked by criticality, alignment with build strategy
// and model ethos, and revenue potential." ADMIN-only (enforced server-side
// via functions.routes.js's ADMIN_FUNCTIONS set, not just a frontend guard).
//
// Reads every Feedback row (the public "SUGGEST AN IMPROVEMENT" box's
// submissions — see submitFeedback.js), asks the configured LLM to rank and
// group them, and stores the result as a single UpdatesPlan row per admin
// (mirrors generateRebuildDoc.js's upsert-by-user pattern).
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { logUsage } from '../lib/projectUtils.js';

const MAX_FEEDBACK_ITEMS = 300; // bound prompt size on a long-running deployment

const planSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One short paragraph on overall themes across the feedback.' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          type: { type: 'string', enum: ['feature', 'bug'] },
          rationale: { type: 'string', description: 'Why this matters — criticality, fit with build strategy/ethos, or revenue potential.' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          related_count: { type: 'integer', description: 'How many submitted items this groups together, at least 1.' },
        },
        required: ['title', 'type', 'rationale', 'priority', 'related_count'],
      },
    },
  },
  required: ['summary', 'items'],
};

function toMarkdown({ summary, items }, feedbackCount) {
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...(items || [])].sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9));
  const lines = [];
  lines.push(`# MORPHEUS UPDATES PLAN`);
  lines.push('');
  lines.push(`> Synthesized from ${feedbackCount} submitted feedback item${feedbackCount === 1 ? '' : 's'} — ${new Date().toISOString()}`);
  lines.push('');
  lines.push(summary || '');
  lines.push('');
  for (const item of sorted) {
    lines.push(`## [${(item.priority || 'medium').toUpperCase()}] ${item.title} (${item.type})`);
    lines.push('');
    lines.push(item.rationale || '');
    if (item.related_count > 1) lines.push(`\n_Groups ${item.related_count} related submissions._`);
    lines.push('');
  }
  return lines.join('\n');
}

export default async function handler({ user }) {
  const feedback = await prisma.feedback.findMany({
    orderBy: { created_date: 'desc' },
    take: MAX_FEEDBACK_ITEMS,
  });

  if (feedback.length === 0) {
    const content = '# MORPHEUS UPDATES PLAN\n\nNo feedback has been submitted yet — nothing to synthesize.';
    const existing = await prisma.updatesPlan.findFirst({ where: { created_by_id: user.id }, orderBy: { created_date: 'desc' } });
    const doc = existing
      ? await prisma.updatesPlan.update({ where: { id: existing.id }, data: { content, feedback_count: 0 } })
      : await prisma.updatesPlan.create({ data: { created_by_id: user.id, content, feedback_count: 0 } });
    return { planId: doc.id, feedbackCount: 0, content };
  }

  const feedbackList = feedback
    .map((f, i) => `${i + 1}. [${f.type}] ${f.message.replace(/\s+/g, ' ').trim()}`)
    .join('\n');

  const prompt = `You are triaging user feedback for Morpheus, an AI-powered, chat-driven app builder. Below are raw FEATURE and BUG submissions from users via a public feedback box, most recent first.

Group near-duplicate submissions together, then rank the resulting list by: (1) criticality — bugs blocking core use rank above nice-to-haves, (2) fit with Morpheus's build strategy and mentor-persona ethos (helping people build and own real software, "free your mind" framing), and (3) revenue potential (e.g. marketplace/monetization-adjacent items). Write concrete, actionable titles — not vague restatements.

Feedback submissions:
${feedbackList}`;

  // 2026-09-03 audit: up to MAX_FEEDBACK_ITEMS (300) items get grouped/ranked
  // into this response with a rationale per group — no maxTokens was set,
  // same undocumented-provider-default exposure as every other call site
  // audited this pass.
  const { result } = await invokeAI({ userId: user.id, prompt, schema: planSchema, role: 'diagnosis', maxTokens: 12000 });
  const content = toMarkdown(result, feedback.length);

  const existing = await prisma.updatesPlan.findFirst({ where: { created_by_id: user.id }, orderBy: { created_date: 'desc' } });
  const doc = existing
    ? await prisma.updatesPlan.update({ where: { id: existing.id }, data: { content, feedback_count: feedback.length } })
    : await prisma.updatesPlan.create({ data: { created_by_id: user.id, content, feedback_count: feedback.length } });

  await logUsage(user.id, 'chat_simple', '', 'updates-plan', { feedbackCount: feedback.length });

  return { planId: doc.id, feedbackCount: feedback.length, content };
}
