// Resolve a Morpheus project to the delivery config for the WordPress site
// it's connected to — the plumbing the "plugin-api" needs so a plain
// project's chat builds can ship through the `wordpress` delivery adapter,
// the same way self-dev ships through the `self-dev` adapter.
//
// A project is "WordPress-connected" when it has a PluginConnection row
// (kind='wordpress', created by the STORE/DEPLOY panel) AND a GitHub repo
// (either stored on the connection or on project.github_repo). The repo is
// what Morpheus diffs + pushes to; the plugin then pulls the merge commit
// onto the live server. Rob's Valiant site is the first tenant; the shape
// is host-agnostic for the multi-tenant build later.
import { prisma } from '../db.js';
import { getGithubToken } from './github.js';
import { getWpConnection } from './wpPlugin.js';

const DEPLOY_ENDPOINT = '/wp-json/morpheus/v1/deploy';

// The project's files as the ship/verify primitives want them.
export async function loadProjectFiles(projectId, userId) {
  const rows = await prisma.projectFile.findMany({
    where: { project_id: projectId, created_by_id: userId },
    select: { path: true, content: true },
  });
  return rows.map((f) => ({ path: f.path, content: f.content ?? '' }));
}

// → { conn, project, config, token } ready for wordpressDelivery.*
// Throws a friendly 400 when a prerequisite is missing.
export async function resolveWordpressDelivery(projectId, userId) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: userId },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, userId);
  if (!conn) {
    throw Object.assign(
      new Error('This project isn’t connected to a WordPress site yet — connect one in the STORE panel first.'),
      { status: 400 },
    );
  }

  const repo = conn.repo || project.github_repo || null;
  if (!repo) {
    throw Object.assign(
      new Error('No GitHub repo for this site. Export the project to GitHub (or set the repo in the plugin), then reconnect.'),
      { status: 400 },
    );
  }

  const token = await getGithubToken(userId, { projectId }); // throws 400 if GitHub not connected

  const meta = conn.meta && typeof conn.meta === 'object' ? conn.meta : {};
  const config = {
    repo,
    branch: meta.branch || 'main',
    siteUrl: conn.siteUrl,
    deployWebhookUrl: conn.siteUrl + DEPLOY_ENDPOINT,
    deploySecret: conn.secret,
    healthPaths: Array.isArray(meta.healthPaths) && meta.healthPaths.length ? meta.healthPaths : null,
    // The named CI gates this tenant's repo runs. Absent for a repo with no CI
    // (the live tenant has none), which is why the WordPress merge requires
    // nothing by default rather than inventing this repo's gate names — see
    // delivery/wordpress.js's merge(). Like `healthPaths`, this is an advanced
    // field of PluginConnection.meta.
    requiredChecks: Array.isArray(meta.requiredChecks)
      ? meta.requiredChecks.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
      : [],
  };

  return { conn, project, config, token };
}
