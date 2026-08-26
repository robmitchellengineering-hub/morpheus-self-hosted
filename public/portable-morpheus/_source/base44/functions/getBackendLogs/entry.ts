import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';

// Pulls runtime logs from deployed backend platforms so users can debug hosted issues.
// Reads deploy metadata from backend/.deploy.json to know which services were deployed.
// Supports: Cloudflare Workers (script status), Supabase (database logs),
//   Render (service logs), Vercel (deployment logs).
// Returns log lines + a dashboard link for manual log viewing.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId, platform } = body;
    if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });

    // Read deploy metadata
    const files = await base44.entities.ProjectFile.filter({ project_id: projectId });
    const deployFile = files.find(f => f.path === 'backend/.deploy.json');
    if (!deployFile) {
      return Response.json({ error: 'No deployment found. Deploy the backend first.' }, { status: 400 });
    }

    const deployInfo = JSON.parse(deployFile.content);
    const settingsRows = await base44.entities.UserSettings.filter({}, '-updated_date', 1);
    const userConnections = settingsRows[0]?.connections ? JSON.parse(settingsRows[0].connections) : {};

    // If no platform specified, pull from the API host
    const targetPlatform = platform || deployInfo.components?.api_host;

    let logs: string[] = [];
    let dashboardUrl: string | undefined;
    let status = 'ok';

    if (targetPlatform === 'cloudflare-workers') {
      const result = await getCloudflareLogs(deployInfo, userConnections);
      logs = result.logs;
      dashboardUrl = result.dashboardUrl;
      status = result.status;
    } else if (targetPlatform === 'supabase-pg' || targetPlatform === 'supabase') {
      const result = await getSupabaseLogs(deployInfo, userConnections);
      logs = result.logs;
      dashboardUrl = result.dashboardUrl;
      status = result.status;
    } else if (targetPlatform === 'render') {
      const result = await getRenderLogs(deployInfo, userConnections);
      logs = result.logs;
      dashboardUrl = result.dashboardUrl;
      status = result.status;
    } else if (targetPlatform === 'vercel') {
      const result = await getVercelLogs(deployInfo, userConnections);
      logs = result.logs;
      dashboardUrl = result.dashboardUrl;
      status = result.status;
    } else if (targetPlatform === 'netlify') {
      const result = await getNetlifyLogs(deployInfo, userConnections);
      logs = result.logs;
      dashboardUrl = result.dashboardUrl;
      status = result.status;
    } else if (targetPlatform === 'railway') {
      const result = await getRailwayLogs(deployInfo, userConnections);
      logs = result.logs;
      dashboardUrl = result.dashboardUrl;
      status = result.status;
    } else if (targetPlatform === 'fly') {
      const result = await getFlyLogs(deployInfo, userConnections);
      logs = result.logs;
      dashboardUrl = result.dashboardUrl;
      status = result.status;
    } else {
      logs = [`Log pulling not supported for "${targetPlatform}". Use the dashboard link to view logs manually.`];
      const { getDashboardUrl } = await import('../../shared/infrastructureComponents.ts');
      dashboardUrl = getDashboardUrl(targetPlatform, userConnections.supabase?.project_ref);
      status = 'unsupported';
    }

    return Response.json({ platform: targetPlatform, logs, dashboardUrl, status });
  } catch (error) {
    console.error('Get backend logs error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}

// --- Cloudflare Workers: check script status (Tail API is WebSocket-only, so we check deployment health) ---

async function getCloudflareLogs(deployInfo: any, userConnections: any): Promise<any> {
  const apiToken = userConnections.cloudflare?.api_token || secrets.get('CLOUDFLARE_API_TOKEN');
  const accountId = userConnections.cloudflare?.account_id || deployInfo.connections?.cloudflare?.account_id || secrets.get('CLOUDFLARE_ACCOUNT_ID');
  const scriptName = deployInfo.connections?.cloudflare?.script_name;

  if (!apiToken || !accountId || !scriptName) {
    return { logs: ['Cloudflare credentials or script name missing. Cannot fetch logs.'], status: 'error' };
  }

  try {
    // Check script health/settings
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/settings`, {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });
    const data = await res.json();

    if (data.success) {
      const logs = [
        `Script: ${scriptName}`,
        `Status: ${data.result?.usage_model ? 'Deployed' : 'Unknown'}`,
        `Created: ${data.result?.created_on || 'N/A'}`,
        `Modified: ${data.result?.modified_on || 'N/A'}`,
        '',
        'Note: Cloudflare Workers real-time logs require "wrangler tail" in a terminal.',
        `Run: npx wrangler tail ${scriptName}`,
        '',
        `Test your API: https://${scriptName}.${accountId.substring(0, 8)}.workers.dev`,
      ];
      return { logs, dashboardUrl: `https://dash.cloudflare.com`, status: 'ok' };
    }
    return { logs: [`Cloudflare API error: ${data.errors?.map((e: any) => e.message).join('; ') || 'Unknown'}`], status: 'error' };
  } catch (e: any) {
    return { logs: [`Error fetching Cloudflare logs: ${e.message}`], status: 'error' };
  }
}

// --- Supabase: pull database logs via Management API ---

async function getSupabaseLogs(deployInfo: any, userConnections: any): Promise<any> {
  const projectRef = userConnections.supabase?.project_ref || deployInfo.connections?.supabase?.project_ref || secrets.get('SUPABASE_PROJECT_REF');
  const accessToken = userConnections.supabase?.access_token || secrets.get('SUPABASE_ACCESS_TOKEN');

  if (!projectRef || !accessToken) {
    return { logs: ['Supabase credentials missing. Cannot fetch logs.'], status: 'error' };
  }

  try {
    // Query recent Postgres logs
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/analytics/database/log-stats`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (res.ok) {
      const data = await res.json();
      const logs = [
        `Supabase project: ${projectRef}`,
        `Log stats: ${JSON.stringify(data).substring(0, 500)}`,
        '',
        'For detailed query logs, open the Supabase dashboard → Logs.',
      ];
      return { logs, dashboardUrl: `https://supabase.com/dashboard/project/${projectRef}/logs`, status: 'ok' };
    }

    // Fallback: just return dashboard link
    return {
      logs: ['Supabase log API returned an error. Open the dashboard to view logs directly.'],
      dashboardUrl: `https://supabase.com/dashboard/project/${projectRef}/logs`,
      status: 'ok'
    };
  } catch (e: any) {
    return {
      logs: [`Error fetching Supabase logs: ${e.message}`],
      dashboardUrl: `https://supabase.com/dashboard/project/${projectRef}/logs`,
      status: 'error'
    };
  }
}

// --- Render: pull service logs via REST API ---

async function getRenderLogs(deployInfo: any, userConnections: any): Promise<any> {
  const apiKey = userConnections.render?.api_key || secrets.get('RENDER_API_KEY');
  const serviceId = userConnections.render?.service_id || deployInfo.connections?.render?.service_id;

  if (!apiKey || !serviceId) {
    return { logs: ['Render API key or service ID missing. Set them in Settings → Connections.'], status: 'error' };
  }

  try {
    const res = await fetch(`https://api.render.com/v1/services/${serviceId}/logs?limit=100`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
    });

    if (res.ok) {
      const data = await res.json();
      const logs = Array.isArray(data) ? data.map((l: any) => l.text || JSON.stringify(l)) : [JSON.stringify(data)];
      return { logs, dashboardUrl: `https://dashboard.render.com/web/${serviceId}`, status: 'ok' };
    }
    const errText = await res.text();
    return { logs: [`Render log API error: ${errText.substring(0, 200)}`], status: 'error' };
  } catch (e: any) {
    return { logs: [`Error fetching Render logs: ${e.message}`], status: 'error' };
  }
}

// --- Netlify: list recent deploys and site status ---

async function getNetlifyLogs(deployInfo: any, userConnections: any): Promise<any> {
  const token = userConnections.netlify?.token || secrets.get('NETLIFY_TOKEN');
  const siteId = userConnections.netlify?.site_id || deployInfo.connections?.netlify?.site_id;

  if (!token) {
    return { logs: ['Netlify token missing. Set it in Settings → Connections.'], status: 'error' };
  }

  try {
    if (siteId) {
      const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys?per_page=10`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const deploys = await res.json();
        const logs = deploys.map((d: any) =>
          `[${d.state || 'unknown'}] ${d.name || 'deploy'} — ${d.created_at || 'N/A'} — ${d.ssl_url || d.url || 'N/A'}`
        );
        return { logs, dashboardUrl: `https://app.netlify.com/sites/${siteId}`, status: 'ok' };
      }
    }
    // No site_id — list all sites
    const res = await fetch(`https://api.netlify.com/api/v1/sites?per_page=5`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.ok) {
      const sites = await res.json();
      const logs = sites.map((s: any) => `${s.name} (${s.ssl_url || s.url}) — ${s.state || 'N/A'}`);
      return { logs, dashboardUrl: `https://app.netlify.com`, status: 'ok' };
    }
    return { logs: ['Could not fetch Netlify data. Check your token.'], status: 'error' };
  } catch (e: any) {
    return { logs: [`Error fetching Netlify data: ${e.message}`], status: 'error' };
  }
}

// --- Railway: pull deployment logs via GraphQL API ---

async function getRailwayLogs(deployInfo: any, userConnections: any): Promise<any> {
  const token = userConnections.railway?.token;
  if (!token) {
    return { logs: ['Railway token missing. Set it in Settings → Connections.'], status: 'error' };
  }

  // The deploy metadata stores the Railway project ID from the deploy step
  const projectId = deployInfo.connections?.railway?.project_id;
  if (!projectId) {
    return { logs: ['No Railway project ID found in deploy metadata. Open the Railway dashboard to view logs.'], dashboardUrl: 'https://railway.app/dashboard', status: 'ok' };
  }

  try {
    // Query the most recent deployment for this project
    const res = await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query { project(id: "${projectId}") { name deployments(first: 1) { edges { node { id status createdAt } } } } }`
      })
    });

    if (res.ok) {
      const data = await res.json();
      const project = data?.data?.project;
      if (project) {
        const logs = [
          `Project: ${project.name}`,
          ...((project.deployments?.edges || []).map((e: any) =>
            `[${e.node.status}] deploy ${e.node.id.substring(0, 8)} — ${e.node.createdAt || 'N/A'}`
          )),
          '',
          'For detailed build/deploy logs, open the Railway dashboard.',
        ];
        return { logs, dashboardUrl: `https://railway.app/project/${projectId}`, status: 'ok' };
      }
    }
    return { logs: ['Could not fetch Railway data. Check your token.'], dashboardUrl: `https://railway.app/project/${projectId}`, status: 'ok' };
  } catch (e: any) {
    return { logs: [`Error fetching Railway data: ${e.message}`], dashboardUrl: 'https://railway.app/dashboard', status: 'error' };
  }
}

// --- Fly.io: check app status (log streaming requires flyctl CLI) ---

async function getFlyLogs(deployInfo: any, userConnections: any): Promise<any> {
  const appName = deployInfo.connections?.fly?.app_name;
  const baseUrl = appName ? `https://fly.io/apps/${appName}` : 'https://fly.io/dashboard';

  if (!appName) {
    return {
      logs: ['No Fly.io app name found in deploy metadata. Open the Fly.io dashboard to view logs.'],
      dashboardUrl: baseUrl,
      status: 'ok'
    };
  }

  try {
    // Check app status via the Fly.io API
    const apiToken = userConnections.fly?.api_token;
    if (!apiToken) {
      return { logs: ['Fly.io API token missing. Set it in Settings → Connections.'], dashboardUrl: baseUrl, status: 'error' };
    }

    const res = await fetch(`https://api.machines.dev/v1/apps/${appName}`, {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });

    if (res.ok) {
      const data = await res.json();
      const machines = Array.isArray(data) ? data : (data.machines || []);
      const logs = [
        `App: ${appName}`,
        `Machines: ${machines.length}`,
        ...machines.slice(0, 5).map((m: any) =>
          `[${m.state || 'unknown'}] ${m.id?.substring(0, 8) || 'N/A'} — ${m.region || 'N/A'}`
        ),
        '',
        'For real-time logs, run: flyctl logs -a ' + appName,
        `Or open the dashboard: ${baseUrl}`,
      ];
      return { logs, dashboardUrl: baseUrl, status: 'ok' };
    }

    return {
      logs: ['Could not fetch Fly.io app status. Open the dashboard to view logs.'],
      dashboardUrl: baseUrl,
      status: 'ok'
    };
  } catch (e: any) {
    return { logs: [`Error fetching Fly.io data: ${e.message}`], dashboardUrl: baseUrl, status: 'error' };
  }
}

// --- Vercel: pull deployment logs via REST API ---

async function getVercelLogs(deployInfo: any, userConnections: any): Promise<any> {
  const token = userConnections.vercel?.token || secrets.get('VERCEL_TOKEN');
  const deploymentId = userConnections.vercel?.deployment_id || deployInfo.connections?.vercel?.deployment_id;
  const teamId = userConnections.vercel?.team_id;

  if (!token || !deploymentId) {
    return { logs: ['Vercel token or deployment ID missing. Set them in Settings → Connections.'], status: 'error' };
  }

  try {
    const url = `https://api.vercel.com/v6/deployments/${deploymentId}/logs${teamId ? `?teamId=${teamId}` : ''}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (res.ok) {
      const data = await res.json();
      const logs = (data.logs || data || []).map((l: any) => {
        if (typeof l === 'string') return l;
        return l.message || l.text || JSON.stringify(l);
      });
      return { logs, dashboardUrl: `https://vercel.com/dashboard`, status: 'ok' };
    }
    const errText = await res.text();
    return { logs: [`Vercel log API error: ${errText.substring(0, 200)}`], status: 'error' };
  } catch (e: any) {
    return { logs: [`Error fetching Vercel logs: ${e.message}`], status: 'error' };
  }
}