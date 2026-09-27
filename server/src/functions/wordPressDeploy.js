// Ship a project's code to its connected WordPress site through the
// `wordpress` delivery adapter. This is the deploy half of the plugin —
// the STORE panel runs the shop, this pushes site changes.
//
// Actions:
//   status  — repo + live-site health + whether the plugin is armed
//   verify  — JS syntax over the project's script files
//   dry_run — diff the project's files against the repo; write nothing
//   ship    — verify, then open a PR with the diff (auto-merge is a
//             separate `merge` poll, self-dev style)
//   merge   — poll the PR's checks; squash-merge on green, then fire the
//             plugin's deploy webhook so the live site pulls the new tree
import { getDeliveryAdapter } from '../lib/delivery/index.js';
import { resolveWordpressDelivery, loadProjectFiles } from '../lib/pluginProject.js';
import { wpStatus } from '../lib/wpPlugin.js';
import { logUsage } from '../lib/projectUtils.js';
import { policyIdForUser, forceAllowed, assertWithinVelocity, assertRepoAllowed } from '../lib/tenantPolicy.js';

const ALLOWED = new Set(['status', 'verify', 'dry_run', 'ship', 'merge']);
const wp = getDeliveryAdapter('wordpress');

export default async function handler({ user, body }) {
  const { projectId, action, prNumber, force = false } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!ALLOWED.has(action)) throw Object.assign(new Error(`Unknown deploy action: ${action}`), { status: 400 });

  const { conn, project, config, token } = await resolveWordpressDelivery(projectId, user.id);
  const policyId = policyIdForUser(user);

  if (action === 'status') {
    const [health, live] = await Promise.all([
      wp.healthCheck({ config }),
      wpStatus(conn.siteUrl),
    ]);
    const plugin = live.ok && live.data?.plugin === 'morpheus' ? live.data : null;
    return {
      connected: true,
      describe: wp.describe(config),
      repo: config.repo,
      branch: config.branch,
      siteUrl: config.siteUrl,
      health,
      plugin: plugin && {
        version: plugin.version,
        armed: !!plugin.deploy?.armed,
        configured: !!plugin.deploy?.configured,
        pluginRepo: plugin.deploy?.repo || null,
        last: plugin.deploy?.last || null,
      },
    };
  }

  if (action === 'merge') {
    if (!prNumber) throw Object.assign(new Error('prNumber required'), { status: 400 });
    const result = await wp.merge({ token, config, prNumber: Number(prNumber), force: forceAllowed(policyId, force) });
    if (result.merged && !result.alreadyMerged) {
      await logUsage(user.id, 'wp_deploy_merge', projectId, project.name, {
        repo: config.repo, prNumber: Number(prNumber), deploy: result.deploy?.triggered,
      });
    }
    return result;
  }

  const files = await loadProjectFiles(projectId, user.id);
  if (files.length === 0) throw Object.assign(new Error('This project has no files to deploy'), { status: 400 });

  if (action === 'verify') {
    return { ...(await wp.verify({ files })) };
  }

  if (action === 'dry_run') {
    // The token reads the repo tree for the diff; the precheck aborts before
    // any branch, commit or PR is created, so nothing is written.
    let captured = null;
    const result = await wp.ship({
      token,
      config,
      files,
      precheck: (cs) => { captured = cs; return { dryRun: true, ...cs }; },
    });
    if (result.reason === 'no-changes') {
      return { dryRun: true, changed: false, createCount: 0, updateCount: 0, deleteCount: 0, changedPaths: [], deletePaths: [] };
    }
    const cs = captured || result;
    return {
      dryRun: true,
      changed: true,
      createCount: cs.createCount || 0,
      updateCount: cs.updateCount || 0,
      deleteCount: (cs.deletePaths || []).length,
      changedPaths: cs.changedPaths || [],
      deletePaths: cs.deletePaths || [],
    };
  }

  // action === 'ship' — policy gates (repo access + velocity), verify, then PR.
  await assertRepoAllowed(token, config.repo, policyId);
  await assertWithinVelocity(user.id, policyId, 'wp_deploy_ship');

  const verify = await wp.verify({ files });
  // Only a real failure blocks the ship. `not_verified` — a PHP-only theme
  // change, which this backend has no `php` to lint — is neither a pass nor a
  // failure: blocking it would stop the normal case for this target, and a gate
  // that cries wolf gets switched off. It is returned with the result so the
  // operator is told "not verified" rather than shown a clean bill of health.
  if (verify.status === 'failed' && !forceAllowed(policyId, force)) {
    return { shipped: false, blocked: true, reason: 'verify', verify };
  }

  const result = await wp.ship({ token, config, files });
  if (result.shipped) {
    await logUsage(user.id, 'wp_deploy_ship', projectId, project.name, {
      repo: config.repo, prNumber: result.prNumber, summary: result.summary,
    });
  }
  return { ...result, verify };
}
