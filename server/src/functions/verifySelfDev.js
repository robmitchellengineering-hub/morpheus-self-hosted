// Pre-push verification for the self-dev workspace (Command Deck 4.0 /
// self-dev-replaces-the-dev-loop, Tier 1 #1). Before PUSH TO PRODUCTION,
// the change must parse, bundle from the real entry points, and keep its
// cross-file named exports intact — the "does not provide an export named X"
// class the 2026-09-06 github.js rewrite shipped to production.
//
// The verify machinery now lives in the shared engine
// (server/src/lib/engine/verify.js) and is reached through the 'self-dev'
// delivery adapter, which supplies self-dev's entry points, exclude rule,
// and the base44/ external shim. This function loads the workspace and
// keeps the admin gate + usage log.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { getDeliveryAdapter } from '../lib/delivery/index.js';

export async function runVerifySelfDev(user) {
  const project = await prisma.project.findFirst({
    where: { created_by_id: user.id, project_type: 'self_dev' },
  });
  if (!project) throw Object.assign(new Error('Self-dev project not found — sync from GitHub first'), { status: 404 });

  const files = await prisma.projectFile.findMany({
    where: { project_id: project.id },
    select: { path: true, content: true },
  });
  if (files.length === 0) throw Object.assign(new Error('Workspace is empty — sync from GitHub first'), { status: 400 });

  const result = await getDeliveryAdapter('self-dev').verify({ files });

  await logUsage(user.id, 'self_dev_verify', project.id, project.name, { ok: result.ok, errorCount: result.errorCount });

  return result;
}

export default async function handler({ user }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });
  return runVerifySelfDev(user);
}
