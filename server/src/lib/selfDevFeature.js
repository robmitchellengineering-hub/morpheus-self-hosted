// Self-dev persistent feature plans (SELF-DEV-V2 A1). Shared helpers for the
// SelfDevFeature model — step (de)serialization, the pre-migration compat
// check, the active-feature read, and the planner context block.
//
// `steps` is stored as a JSON string: [{ n, title, status, ref?, note? }]
// status ∈ 'pending' | 'active' | 'done'. Exactly one step is 'active' while
// the feature itself is 'active'.
import { prisma } from '../db.js';

// The self_dev_features table ships ahead of its migration (like
// self_dev_manuals, template.artifact_files — see lib/templateCompat.js). Any
// Prisma call on the model throws "relation ... does not exist" / P2021 until
// server/prisma/add-self-dev-features-table.sql is run. Detect that so the
// FEATURE panel degrades to "migration pending" instead of crashing self-dev.
export function isMissingFeatureTable(err) {
  const m = err && typeof err.message === 'string' ? err.message : '';
  return err?.code === 'P2021'
    || /relation\s+"?self_dev_features"?\s+does not exist/i.test(m)
    || /table\s+.*self_dev_features.*does not exist/i.test(m)
    // Prisma client generated before the model existed — `prisma.selfDevFeature`
    // is undefined, so a call on it throws this. Same "not available yet"
    // situation from the caller's point of view.
    || /Cannot read properties of undefined \(reading '(find|create|update|delete)/i.test(m);
}

export function parseSteps(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s, i) => ({
        n: Number.isInteger(s?.n) ? s.n : i + 1,
        title: String(s?.title || '').trim(),
        status: ['pending', 'active', 'done'].includes(s?.status) ? s.status : 'pending',
        ref: s?.ref || null,
        note: s?.note || null,
      }))
      .filter((s) => s.title);
  } catch {
    return [];
  }
}

export const serializeSteps = (steps) => JSON.stringify(steps || []);

// Normalize so exactly one step is 'active' (the first non-done one) unless
// every step is done — used after any status edit.
export function normalizeSteps(steps) {
  const out = steps.map((s, i) => ({ ...s, n: i + 1 }));
  const firstOpen = out.find((s) => s.status !== 'done');
  for (const s of out) {
    if (s.status === 'done') continue;
    s.status = s === firstOpen ? 'active' : 'pending';
  }
  return out;
}

export function hydrate(feature) {
  if (!feature) return null;
  const steps = parseSteps(feature.steps);
  const active = steps.find((s) => s.status === 'active') || null;
  return {
    id: feature.id,
    projectId: feature.project_id,
    title: feature.title,
    goal: feature.goal,
    status: feature.status,
    steps,
    activeStep: active,
    doneCount: steps.filter((s) => s.status === 'done').length,
    totalSteps: steps.length,
    created_date: feature.created_date,
    updated_date: feature.updated_date,
  };
}

// The active feature for a self-dev project, hydrated — or null (no feature,
// or the table isn't migrated yet).
export async function getActiveFeature(projectId) {
  try {
    const row = await prisma.selfDevFeature.findFirst({
      where: { project_id: projectId, status: 'active' },
      orderBy: { created_date: 'desc' },
    });
    return hydrate(row);
  } catch (err) {
    if (isMissingFeatureTable(err)) return null;
    throw err;
  }
}

// The block handed to the planner on a self-dev build turn when a feature is
// active. Keeps the planner on the current step and aware of what's shipped.
export function featureContextBlock(feature) {
  if (!feature || feature.status !== 'active' || feature.steps.length === 0) return '';
  const lines = feature.steps.map((s) => {
    const tag = s.status === 'done' ? 'done' : s.status === 'active' ? 'ACTIVE — implement THIS step only' : 'pending';
    return `  ${s.n}. [${tag}] ${s.title}${s.ref ? ` (${s.ref})` : ''}`;
  });
  return `
ACTIVE FEATURE — "${feature.title}"
GOAL: ${feature.goal}
STEPS:
${lines.join('\n')}

You are building this feature one step per turn. Implement ONLY the step marked ACTIVE. Do not start a later step, and do not redo a step marked done. If the operator's message is clearly a bug fix or a change outside this feature, follow the operator instead and leave the feature steps alone.
`;
}
