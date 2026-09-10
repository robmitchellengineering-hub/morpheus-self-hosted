// Ship a project's code to its connected WordPress site through the
// `wordpress` delivery adapter. This is the deploy half of the plugin —
// the STORE panel runs the shop, this pushes site changes.
//
// Slice 1 is read-only: `status` (repo + live-site health + whether the
// plugin is armed) and `dry_run` (diff the project's current files against
// the repo, report what a deploy would change — nothing is pushed). The
// armed ship + auto-merge path lands once there's a staging site to prove
// rollback on.
import { getDeliveryAdapter } from '../lib/delivery/index.js';
import { resolveWordpressDelivery, loadProjectFiles } from '../lib/pluginProject.js';
import { wpStatus } from '../lib/wpPlugin.js';

const ALLOWED = new Set(['status', 'verify', 'dry_run']);
const wp = getDeliveryAdapter('wordpress');

export default async function handler({ user, body }) {
  const { projectId, action } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!ALLOWED.has(action)) throw Object.assign(new Error(`Unknown deploy action: ${action}`), { status: 400 });

  const { conn, config, token } = await resolveWordpressDelivery(projectId, user.id);

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

  const files = await loadProjectFiles(projectId, user.id);
  if (files.length === 0) throw Object.assign(new Error('This project has no files to deploy'), { status: 400 });

  if (action === 'verify') {
    return { ...(await wp.verify({ files })) };
  }

  // dry_run — compute the diff, push nothing. The adapter's ship() runs the
  // engine diff; a precheck that captures the counts and returns truthy
  // aborts before any branch/PR is created.
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
