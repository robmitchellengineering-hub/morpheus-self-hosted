// Ported from base44/functions/checkDeployHealth/entry.ts.
//
// PUBLIC function (see PUBLIC_FUNCTIONS in routes/functions.routes.js) — no
// auth required, `user` may be null. Pings a deployed backend URL and
// returns its health status. Also reads stored deploy metadata to
// auto-discover the URL if not provided.
import { prisma } from '../db.js';
import { checkHealth } from '../lib/healthCheck.js';

export default async function handler({ body }) {
  const { url, projectId } = body || {};

  let targetUrl = url;

  // If no URL provided but projectId is, look up the deploy metadata.
  // This is a public endpoint (no user scoping) — matches the original,
  // which used base44.entities.* without an owner filter here.
  if (!targetUrl && projectId) {
    // Prefer custom domain if configured — that's what the frontend uses
    const config = await prisma.backendConfig.findFirst({ where: { project_id: projectId } });
    if (config?.custom_domain) {
      targetUrl = config.custom_domain;
    }

    // Fall back to the first deployed component's URL
    if (!targetUrl) {
      const deployFile = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: 'backend/.deploy.json' } });
      if (deployFile) {
        const deployInfo = JSON.parse(deployFile.content);
        const deployed = (deployInfo.results || []).find((r) => r.status === 'deployed' && r.url);
        if (deployed?.url) {
          targetUrl = deployed.url;
        }
      }
    }
  }

  if (!targetUrl) {
    throw Object.assign(new Error('No URL provided and no deployed URL found in project metadata'), { status: 400 });
  }

  // Normalize URL — ensure it has a protocol
  if (!targetUrl.startsWith('http')) {
    targetUrl = `https://${targetUrl}`;
  }

  const result = await checkHealth(targetUrl, { maxRetries: 3, retryDelayMs: 2000, timeoutMs: 8000 });

  return {
    url: targetUrl,
    healthy: result.healthy,
    statusCode: result.statusCode,
    responseTimeMs: result.responseTimeMs,
    error: result.error,
    attempts: result.attempts,
  };
}
