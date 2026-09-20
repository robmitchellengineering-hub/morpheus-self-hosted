// Reading and writing the per-site maintenance policy row.
//
// Kept apart from lib/siteMaintenance.js so the RULES stay pure and assertable
// while the Prisma access lives here (hazard H4: a guard may not reach
// @prisma/client).
import { prisma } from '../db.js';
import { POLICY_DEFAULTS, validatePolicy } from './siteMaintenance.js';

/** The policy row for a project, or the safe defaults when none exists yet. */
export async function getPolicy(projectId) {
  const row = await prisma.siteMaintenancePolicy.findUnique({ where: { project_id: projectId } });
  if (!row) return { ...POLICY_DEFAULTS, project_id: projectId, exists: false };
  return { ...row, exists: true };
}

/**
 * Apply a partial policy, validated. Returns `{ ok, policy, errors }` so a caller
 * can refuse a bad request instead of half-applying it.
 */
export async function savePolicy(user, projectId, input) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404, code: 'NO_PROJECT' });

  const current = await getPolicy(projectId);
  const { ok, policy, errors } = validatePolicy(input, current);
  if (!ok) return { ok: false, errors, policy: current };

  const data = {
    scan_enabled: policy.scan_enabled,
    day_of_month: policy.day_of_month,
    hour_utc: policy.hour_utc,
    apply_plugins: policy.apply_plugins,
    apply_themes: policy.apply_themes,
    apply_core_minor: policy.apply_core_minor,
    allow_core_major_manual: policy.allow_core_major_manual,
  };

  const row = await prisma.siteMaintenancePolicy.upsert({
    where: { project_id: projectId },
    create: { created_by_id: user.id, project_id: projectId, ...data },
    update: data,
  });
  return { ok: true, errors: [], policy: { ...row, exists: true } };
}

/**
 * Record what a scheduled run found.
 *
 * Best-effort by design: the scan already happened and its report has already
 * been written to the chat, so failing to stamp the row must not turn a
 * completed run into an error the operator sees.
 */
export async function recordRun(projectId, { at, result }) {
  try {
    await prisma.siteMaintenancePolicy.update({
      where: { project_id: projectId },
      data: {
        last_scan_at: new Date(at),
        // Truncated: this is a summary for the panel, not a log store.
        last_result: JSON.stringify(result).slice(0, 4000),
      },
    });
    return true;
  } catch (err) {
    console.warn(`[site-maintenance] could not record the run for project ${projectId}:`, err.message);
    return false;
  }
}

/** Every policy with scheduled checks on — the scheduler's work list. */
export async function enabledPolicies() {
  return prisma.siteMaintenancePolicy.findMany({ where: { scan_enabled: true } });
}
