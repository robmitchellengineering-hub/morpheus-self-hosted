// Rolling-average latency per AI role (planner/coder/reviewer), fed by every
// invokeAI() call (see ai.js) and read by chatWithMorpheus.js's streamed
// progress events to give the operator a real, self-correcting ETA per
// pipeline stage — see Rob's 2026-09-03 request to show step-by-step
// progress with an ETA instead of the old cycling decorative status text.
//
// In-memory, per-process: resets on redeploy/restart and isn't shared across
// horizontally-scaled replicas. That's an accepted trade for zero extra
// infra (no new table/migration, no Redis dependency) — the numbers settle
// back to something accurate within a handful of real calls after any reset,
// and a rough-but-live ETA beats either a static guess that goes stale the
// moment the model/provider/prompt size changes, or no ETA at all.
const WINDOW = 20; // keep the last N samples per role — recent behavior matters more than all-time average

const samples = new Map(); // role -> number[] (milliseconds)

// Seed values (2026-09-03 live measurements against this deployment's
// default model, deepseek-v4-flash) so the first request right after a
// deploy still shows a sane number instead of 0s/blank — overwritten by
// real samples within a few calls.
const SEED_MS = {
  planner: 45000,
  coder: 95000,
  reviewer: 45000,
};
const DEFAULT_SEED_MS = 60000;

export function recordCallDuration(role, ms) {
  if (!role || !Number.isFinite(ms) || ms <= 0) return;
  const list = samples.get(role) || [];
  list.push(ms);
  if (list.length > WINDOW) list.shift();
  samples.set(role, list);
}

export function estimateCallMs(role) {
  const list = samples.get(role);
  if (!list || list.length === 0) return SEED_MS[role] ?? DEFAULT_SEED_MS;
  return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
}
