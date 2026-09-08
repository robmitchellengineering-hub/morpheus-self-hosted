// Mutate a self-dev feature (SELF-DEV-V2 A1). Actions:
//   completeStep { stepN, ref? }  — mark that step done, activate the next
//   reopenStep   { stepN }        — send that step (and later ones) back to open
//   setSteps     { steps: [str] } — replace the step list, preserving done-ness
//                                    by matching title
//   abandon                       — status = 'abandoned'
//   complete                      — status = 'done' (all steps forced done)
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import {
  isMissingFeatureTable, parseSteps, serializeSteps, normalizeSteps, hydrate,
} from '../lib/selfDevFeature.js';

export async function runUpdateSelfDevFeature(user, featureId, action, args = {}) {
  let feature;
  try {
    feature = await prisma.selfDevFeature.findUnique({ where: { id: featureId } });
  } catch (err) {
    if (isMissingFeatureTable(err)) throw Object.assign(new Error('self_dev_features table not migrated yet.'), { status: 503 });
    throw err;
  }
  if (!feature || feature.created_by_id !== user.id) {
    throw Object.assign(new Error('Feature not found'), { status: 404 });
  }

  let steps = parseSteps(feature.steps);
  let status = feature.status;
  let chatNote = null;

  switch (action) {
    case 'completeStep': {
      const step = steps.find((s) => s.n === Number(args.stepN));
      if (!step) throw Object.assign(new Error(`No step ${args.stepN}`), { status: 400 });
      step.status = 'done';
      if (args.ref) step.ref = String(args.ref).slice(0, 120);
      steps = normalizeSteps(steps);
      if (steps.every((s) => s.status === 'done')) {
        status = 'done';
        chatNote = `Feature "${feature.title}" complete — all ${steps.length} steps shipped.`;
      } else {
        const next = steps.find((s) => s.status === 'active');
        chatNote = `Step ${step.n} ("${step.title}") done.${next ? ` Now on step ${next.n}: "${next.title}".` : ''}`;
      }
      break;
    }
    case 'reopenStep': {
      const idx = steps.findIndex((s) => s.n === Number(args.stepN));
      if (idx === -1) throw Object.assign(new Error(`No step ${args.stepN}`), { status: 400 });
      for (let i = idx; i < steps.length; i++) steps[i].status = 'pending';
      steps = normalizeSteps(steps);
      if (status === 'done') status = 'active';
      chatNote = `Reopened step ${args.stepN}.`;
      break;
    }
    case 'setSteps': {
      const titles = Array.isArray(args.steps) ? args.steps.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 12) : [];
      if (titles.length === 0) throw Object.assign(new Error('steps must be a non-empty array'), { status: 400 });
      const doneTitles = new Set(steps.filter((s) => s.status === 'done').map((s) => s.title));
      steps = normalizeSteps(titles.map((title, i) => ({ n: i + 1, title, status: doneTitles.has(title) ? 'done' : 'pending' })));
      chatNote = `Feature "${feature.title}" steps updated (${steps.length}).`;
      break;
    }
    case 'abandon':
      status = 'abandoned';
      chatNote = `Abandoned feature "${feature.title}".`;
      break;
    case 'complete':
      steps = steps.map((s) => ({ ...s, status: 'done' }));
      status = 'done';
      chatNote = `Marked feature "${feature.title}" complete.`;
      break;
    default:
      throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
  }

  const updated = await prisma.selfDevFeature.update({
    where: { id: featureId },
    data: { steps: serializeSteps(steps), status },
  });

  if (chatNote) {
    await prisma.chatMessage.create({
      data: { created_by_id: user.id, project_id: feature.project_id, role: 'morpheus', content: chatNote },
    });
  }
  await logUsage(user.id, 'self_dev_feature_update', feature.project_id, feature.title, { action, status });

  return { feature: hydrate(updated) };
}

export default async function handler({ user, body }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });
  const { featureId, action } = body || {};
  if (!featureId || !action) throw Object.assign(new Error('featureId and action required'), { status: 400 });
  return runUpdateSelfDevFeature(user, featureId, action, body);
}
