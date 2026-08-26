import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { checkHealth } from '../../shared/healthCheck.ts';

// Health check endpoint: pings a deployed backend URL and returns its health status.
// Used by the BackendPanel after deploy to verify the service is live.
// Also reads stored deploy metadata to auto-discover the URL if not provided.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { url, projectId } = body;

    let targetUrl = url;

    // If no URL provided but projectId is, look up the deploy metadata
    if (!targetUrl && projectId) {
      // Prefer custom domain if configured — that's what the frontend uses
      const configRows = await base44.entities.BackendConfig.filter({ project_id: projectId });
      if (configRows[0]?.custom_domain) {
        targetUrl = configRows[0].custom_domain;
      }

      // Fall back to the first deployed component's URL
      if (!targetUrl) {
        const files = await base44.entities.ProjectFile.filter({ project_id: projectId });
        const deployFile = files.find(f => f.path === 'backend/.deploy.json');
        if (deployFile) {
          const deployInfo = JSON.parse(deployFile.content);
          const deployed = (deployInfo.results || []).find((r: any) => r.status === 'deployed' && r.url);
          if (deployed?.url) {
            targetUrl = deployed.url;
          }
        }
      }
    }

    if (!targetUrl) {
      return Response.json({ error: 'No URL provided and no deployed URL found in project metadata' }, { status: 400 });
    }

    // Normalize URL — ensure it has a protocol
    if (!targetUrl.startsWith('http')) {
      targetUrl = `https://${targetUrl}`;
    }

    const result = await checkHealth(targetUrl, { maxRetries: 3, retryDelayMs: 2000, timeoutMs: 8000 });

    return Response.json({
      url: targetUrl,
      healthy: result.healthy,
      statusCode: result.statusCode,
      responseTimeMs: result.responseTimeMs,
      error: result.error,
      attempts: result.attempts,
    });
  } catch (error) {
    console.error('checkDeployHealth error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}