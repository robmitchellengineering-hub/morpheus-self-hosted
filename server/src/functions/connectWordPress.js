// Connect a project to a Morpheus WordPress plugin on the operator's own
// site. Verifies the site is reachable and the plugin is installed, then
// stores { site URL, signing secret } (secret encrypted at rest).
import { prisma } from '../db.js';
import { normalizeSiteUrl, wpStatus, upsertWpConnection, isMissingPluginTable } from '../lib/wpPlugin.js';

export default async function handler({ user, body }) {
  const { projectId, siteUrl: rawUrl, webhookSecret } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const siteUrl = normalizeSiteUrl(rawUrl);
  if (!siteUrl) throw Object.assign(new Error('Enter the site URL, e.g. https://valiantmusic.com.au'), { status: 400 });
  const secret = typeof webhookSecret === 'string' ? webhookSecret.trim() : '';
  if (secret.length < 12) throw Object.assign(new Error('The signing secret must be at least 12 characters — set the same value in the plugin.'), { status: 400 });

  const status = await wpStatus(siteUrl);
  if (!status.ok || !status.data || status.data.plugin !== 'morpheus') {
    throw Object.assign(
      new Error(status.error
        ? `Could not reach ${siteUrl}/wp-json/morpheus/v1/status — ${status.error}`
        : `${siteUrl} responded (${status.status}) but the Morpheus plugin isn't answering there. Install and activate it first.`),
      { status: 502 },
    );
  }

  try {
    await upsertWpConnection(projectId, user.id, {
      siteUrl,
      secret,
      repo: status.data?.deploy?.repo || null,
      meta: { connectedAt: new Date().toISOString(), version: status.data.version, store: status.data.store },
    });
  } catch (err) {
    if (isMissingPluginTable(err)) {
      throw Object.assign(new Error('Plugin connections table is not migrated yet — run add-plugin-connections.sql.'), { status: 503 });
    }
    throw err;
  }

  return {
    connected: true,
    siteUrl,
    version: status.data.version,
    store: status.data.store,
    deploy: status.data.deploy,
  };
}
