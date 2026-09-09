// Start a feature (originally self-dev A1, now any project): the operator
// describes a feature; one planner call breaks it into an ordered list of
// small, shippable steps; it's saved as the project's active feature. From
// then on chatWithMorpheus.js gives the planner the goal + steps + current
// step every build turn (see lib/selfDevFeature.js).
//
// One active feature per project — refuses if one already exists (finish or
// abandon it first, via updateSelfDevFeature.js).
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { logUsage } from '../lib/projectUtils.js';
import { isMissingFeatureTable, serializeSteps, normalizeSteps, hydrate } from '../lib/selfDevFeature.js';

const SYSTEM = `You are the planning agent inside Morpheus, an AI app builder.

The operator has described a FEATURE they want to add to their project. Break it into an ordered list of small, individually shippable steps — each step is one build turn that ends in a reviewable change (e.g. "add the data model", "add the API endpoint", "wire the UI panel").

RULES:
- 3 to 8 steps. Fewer if the feature is genuinely small.
- Each step must be independently reviewable and leave the app working — never "half a schema change".
- Order them so each step builds on the last (data → logic → wiring → UI is the usual shape).
- Step titles are short imperative phrases, no numbering, no prose.
- Also give the feature a short title (2-5 words).
- Return ONLY JSON: { "title": "...", "steps": ["...", "..."] }`;

export async function runPlanSelfDevFeature(user, projectId, goal) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  let existing;
  try {
    existing = await prisma.selfDevFeature.findFirst({ where: { project_id: projectId, status: 'active' } });
  } catch (err) {
    if (isMissingFeatureTable(err)) {
      throw Object.assign(new Error('The self_dev_features table has not been created yet — run server/prisma/add-self-dev-features-table.sql against the database.'), { status: 503 });
    }
    throw err;
  }
  if (existing) {
    throw Object.assign(new Error(`A feature ("${existing.title}") is already active — finish or abandon it first.`), { status: 409 });
  }

  const { result } = await invokeAI({
    userId: user.id,
    prompt: `${SYSTEM}\n\nFEATURE THE OPERATOR WANTS:\n${goal}\n\nReturn the JSON now.`,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '2-5 word feature title' },
        steps: { type: 'array', items: { type: 'string' }, description: '3-8 ordered, individually shippable step titles' },
      },
    },
    role: 'planner',
    maxTokens: 4000,
  });

  const stepTitles = Array.isArray(result.steps) ? result.steps.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 8) : [];
  if (stepTitles.length === 0) {
    throw Object.assign(new Error('The planner did not return any steps — try describing the feature more concretely.'), { status: 502 });
  }
  const steps = normalizeSteps(stepTitles.map((title, i) => ({ n: i + 1, title, status: i === 0 ? 'active' : 'pending' })));
  const title = String(result.title || '').trim() || goal.slice(0, 40);

  const feature = await prisma.selfDevFeature.create({
    data: {
      created_by_id: user.id,
      project_id: projectId,
      title,
      goal,
      steps: serializeSteps(steps),
      status: 'active',
    },
  });

  await prisma.chatMessage.create({
    data: {
      created_by_id: user.id, project_id: projectId, role: 'morpheus',
      content: `Started feature "${title}" — ${steps.length} steps:\n${steps.map((s) => `${s.n}. ${s.title}`).join('\n')}\n\nI'll work step ${steps[0].n} ("${steps[0].title}") on the next build turn. Mark a step done in the FEATURE panel when its push is in.`,
    },
  });
  await logUsage(user.id, 'self_dev_feature_plan', projectId, project.name, { title, stepCount: steps.length });

  return { feature: hydrate(feature) };
}

export default async function handler({ user, body }) {
  const projectId = body?.projectId;
  const goal = String(body?.goal || '').trim();
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (goal.length < 10) throw Object.assign(new Error('Describe the feature in a sentence or two.'), { status: 400 });
  return runPlanSelfDevFeature(user, projectId, goal);
}
