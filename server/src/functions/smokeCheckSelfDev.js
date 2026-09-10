// Post-deploy smoke check (self-dev v2, gap A4.1).
//
// verifySelfDev catches syntax + import/export breakage before a push;
// the deploy watcher catches a *failed* Northflank build/deploy. Neither
// catches "the deploy went green but the change broke a live endpoint" —
// e.g. the chat route now 500s, or the frontend bundle 404s. This hits the
// real, just-deployed production URLs black-box and reports which critical
// paths still respond. SelfDev.jsx runs it once when the deploy watcher
// flips to 'deployed'; a failure feeds the same auto-diagnose flow a failed
// deploy does.
//
// The probe list itself now lives in the 'self-dev' delivery adapter
// (server/src/lib/delivery/selfDev.js) so the shared engine has one place
// to ask "is the deployed site healthy?"; this function keeps the admin
// gate and the usage log.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { getDeliveryAdapter } from '../lib/delivery/index.js';

export async function runSmokeCheckSelfDev(user) {
  const result = await getDeliveryAdapter('self-dev').healthCheck({ user });

  try {
    const project = await prisma.project.findFirst({ where: { created_by_id: user.id, project_type: 'self_dev' } });
    if (project) await logUsage(user.id, 'self_dev_smoke', project.id, project.name, { ok: result.ok, failing: result.failing });
  } catch { /* logging is best-effort */ }

  return result;
}

export default async function handler({ user }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });
  return runSmokeCheckSelfDev(user);
}
