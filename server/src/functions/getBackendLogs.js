// Ported from base44/functions/getBackendLogs/entry.ts. Pulls runtime logs
// from whichever platform a project's backend was deployed to, reading
// deploy metadata from `backend/.deploy.json` (a project file written by
// deployBackend.js) plus the user's UserSettings.connections credentials.
// `secrets.get(X)` (Base44's server-side secret store) maps to `process.env.X`
// — a house-wide fallback credential, same role it played in the original.
import { prisma } from '../db.js';
import { getDashboardUrl } from '../lib/infrastructureComponents.js';
import { decodeConnections } from '../lib/connectionSecrets.js';

export default async function handler({ user, body }) {
  const { projectId, platform } = body;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const files = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  const deployFile = files.find((f) => f.path === 'backend/.deploy.json');
  if (!deployFile) throw Object.assign(new Error('No deployment found. Deploy the backend first.'), { status: 400 });

  const deployInfo = JSON.parse(deployFile.content);
  const settings = await prisma.userSettings.findUnique({ where: { created_by_id: user.id } });
  const userConnections = decodeConnections(settings?.connections);

  const targetPlatform = platform || deployInfo.components?.api_host;

  let result;
  switch (targetPlatform) {
    case 'cloudflare-workers': result = await getCloudflareLogs(deployInfo, userConnections); break;
    case 'supabase-pg':
    case 'supabase': result = await getSupabaseLogs(deployInfo, userConnections); break;
    case 'render': result = await getRenderLogs(deployInfo, userConnections); break;
    case 'vercel': result = await getVercelLogs(deployInfo, userConnections); break;
    case 'netlify': result = await getNetlifyLogs(deployInfo, userConnections); break;
    case 'railway': result = await getRailwayLogs(deployInfo, userConnections); break;
    case 'fly': result = await getFlyLogs(deployInfo, userConnections); break;
    default:
      result = {
        logs: [`Log pulling not supported for "${targetPlatform}". Use the dashboard link to view logs manually.`],
        dashboardUrl: getDashboardUrl(targetPlatform, userConnections.supabase?.project_ref),
        status: 'unsupported',
      };
  }

  return { platform: targetPlatform, logs: result.logs, dashboardUrl: result.dashboardUrl, status: result.status };
}

// --- Cloudflare Workers: check script status (Tail API is WebSocket-only) ---
async function getCloudflareLogs(deployInfo, userConnections) {
  const apiToken = userConnections.cloudflare?.api_token || process.env.CLOUDFLARE_API_TOKEN;
  const accountId = userConnections.cloudflare?.account_id || deployInfo.connections?.cloudflare?.account_id || process.env.CLOUDFLARE_ACCOUNT_ID;
  const scriptName = deployInfo.connections?.cloudflare?.script_name;

  if (!apiToken || !accountId || !scriptName) {
    return { logs: ['Cloudflare credentials or script name missing. Cannot fetch logs.'], status: 'error' };
  }
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/settings`, {
      headers: { Authorization: `Bearer ${apiToken}` },
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
      return { logs, dashboardUrl: 'https://dash.cloudflare.com', status: 'ok' };
    }
    return { logs: [`Cloudflare API error: ${(data.errors || []).map((e) => e.message).join('; ') || 'Unknown'}`], status: 'error' };
  } catch (e) {
    return { logs: [`Error fetching Cloudflare logs: ${e.message}`], status: 'error' };
  }
}

// --- Supabase: pull database logs via Management API ---
async function getSupabaseLogs(deployInfo, userConnections) {
  const projectRef = userConnections.supabase?.project_ref || deployInfo.connections?.supabase?.project_ref || process.env.SUPABASE_PROJECT_REF;
  const accessToken = userConnections.supabase?.access_token || process.env.SUPABASE_ACCESS_TOKEN;

  if (!projectRef || !accessToken) return { logs: ['Supabase credentials missing. Cannot fetch logs.'], status: 'error' };
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/analytics/database/log-stats`, {
      headers: { Authorization: `Bearer ${accessToken}` },
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
    return { logs: ['Supabase log API returned an error. Open the dashboard to view logs directly.'], dashboardUrl: `https://supabase.com/dashboard/project/${projectRef}/logs`, status: 'ok' };
  } catch (e) {
    return { logs: [`Error fetching Supabase logs: ${e.message}`], dashboardUrl: `https://supabase.com/dashboard/project/${projectRef}/logs`, status: 'error' };
  }
}

// --- Render: pull service logs via REST API ---
async function getRenderLogs(deployInfo, userConnections) {
  const apiKey = userConnections.render?.api_key || process.env.RENDER_API_KEY;
  const serviceId = userConnections.render?.service_id || deployInfo.connections?.render?.service_id;
  if (!apiKey || !serviceId) return { logs: ['Render API key or service ID missing. Set them in Settings → Connections.'], status: 'error' };
  try {
    const res = await fetch(`https://api.render.com/v1/services/${serviceId}/logs?limit=100`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      const logs = Array.isArray(data) ? data.map((l) => l.text || JSON.stringify(l)) : [JSON.stringify(data)];
      return { logs, dashboardUrl: `https://dashboard.render.com/web/${serviceId}`, status: 'ok' };
    }
    const errText = await res.text();
    return { logs: [`Render log API error: ${errText.substring(0, 200)}`], status: 'error' };
  } catch (e) {
    return { logs: [`Error fetching Render logs: ${e.message}`], status: 'error' };
  }
}

// --- Netlify: list recent deploys and site status ---
async function getNetlifyLogs(deployInfo, userConnections) {
  const token = userConnections.netlify?.token || process.env.NETLIFY_TOKEN;
  const siteId = userConnections.netlify?.site_id || deployInfo.connections?.netlify?.site_id;
  if (!token) return { logs: ['Netlify token missing. Set it in Settings → Connections.'], status: 'error' };
  try {
    if (siteId) {
      const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys?per_page=10`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const deploys = await res.json();
        const logs = deploys.map((d) => `[${d.state || 'unknown'}] ${d.name || 'deploy'} — ${d.created_at || 'N/A'} — ${d.ssl_url || d.url || 'N/A'}`);
        return { logs, dashboardUrl: `https://app.netlify.com/sites/${siteId}`, status: 'ok' };
      }
    }
    const res = await fetch('https://api.netlify.com/api/v1/sites?per_page=5', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const sites = await res.json();
      const logs = sites.map((s) => `${s.name} (${s.ssl_url || s.url}) — ${s.state || 'N/A'}`);
      return { logs, dashboardUrl: 'https://app.netlify.com', status: 'ok' };
    }
    return { logs: ['Could not fetch Netlify data. Check your token.'], status: 'error' };
  } catch (e) {
    return { logs: [`Error fetching Netlify data: ${e.message}`], status: 'error' };
  }
}

// --- Railway: pull deployment logs via GraphQL API ---
async function getRailwayLogs(deployInfo, userConnections) {
  const token = userConnections.railway?.token;
  if (!token) return { logs: ['Railway token missing. Set it in Settings → Connections.'], status: 'error' };
  const projectId = deployInfo.connections?.railway?.project_id;
  if (!projectId) return { logs: ['No Railway project ID found in deploy metadata. Open the Railway dashboard to view logs.'], dashboardUrl: 'https://railway.app/dashboard', status: 'ok' };
  try {
    const res = await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query { project(id: "${projectId}") { name deployments(first: 1) { edges { node { id status createdAt } } } } }` }),
    });
    if (res.ok) {
      const data = await res.json();
      const project = data?.data?.project;
      if (project) {
        const logs = [
          `Project: ${project.name}`,
          ...((project.deployments?.edges || []).map((e) => `[${e.node.status}] deploy ${e.node.id.substring(0, 8)} — ${e.node.createdAt || 'N/A'}`)),
          '',
          'For detailed build/deploy logs, open the Railway dashboard.',
        ];
        return { logs, dashboardUrl: `https://railway.app/project/${projectId}`, status: 'ok' };
      }
    }
    return { logs: ['Could not fetch Railway data. Check your token.'], dashboardUrl: `https://railway.app/project/${projectId}`, status: 'ok' };
  } catch (e) {
    return { logs: [`Error fetching Railway data: ${e.message}`], dashboardUrl: 'https://railway.app/dashboard', status: 'error' };
  }
}

// --- Fly.io: check app status (log streaming requires flyctl CLI) ---
async function getFlyLogs(deployInfo, userConnections) {
  const appName = deployInfo.connections?.fly?.app_name;
  const baseUrl = appName ? `https://fly.io/apps/${appName}` : 'https://fly.io/dashboard';
  if (!appName) return { logs: ['No Fly.io app name found in deploy metadata. Open the Fly.io dashboard to view logs.'], dashboardUrl: baseUrl, status: 'ok' };
  try {
    const apiToken = userConnections.fly?.api_token;
    if (!apiToken) return { logs: ['Fly.io API token missing. Set it in Settings → Connections.'], dashboardUrl: baseUrl, status: 'error' };
    const res = await fetch(`https://api.machines.dev/v1/apps/${appName}`, { headers: { Authorization: `Bearer ${apiToken}` } });
    if (res.ok) {
      const data = await res.json();
      const machines = Array.isArray(data) ? data : (data.machines || []);
      const logs = [
        `App: ${appName}`,
        `Machines: ${machines.length}`,
        ...machines.slice(0, 5).map((m) => `[${m.state || 'unknown'}] ${m.id?.substring(0, 8) || 'N/A'} — ${m.region || 'N/A'}`),
        '',
        'For real-time logs, run: flyctl logs -a ' + appName,
        `Or open the dashboard: ${baseUrl}`,
      ];
      return { logs, dashboardUrl: baseUrl, status: 'ok' };
    }
    return { logs: ['Could not fetch Fly.io app status. Open the dashboard to view logs.'], dashboardUrl: baseUrl, status: 'ok' };
  } catch (e) {
    return { logs: [`Error fetching Fly.io data: ${e.message}`], dashboardUrl: baseUrl, status: 'error' };
  }
}

// --- Vercel: pull deployment logs via REST API ---
async function getVercelLogs(deployInfo, userConnections) {
  const token = userConnections.vercel?.token || process.env.VERCEL_TOKEN;
  const deploymentId = userConnections.vercel?.deployment_id || deployInfo.connections?.vercel?.deployment_id;
  const teamId = userConnections.vercel?.team_id;
  if (!token || !deploymentId) return { logs: ['Vercel token or deployment ID missing. Set them in Settings → Connections.'], status: 'error' };
  try {
    const url = `https://api.vercel.com/v6/deployments/${deploymentId}/logs${teamId ? `?teamId=${teamId}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      const logs = (data.logs || data || []).map((l) => (typeof l === 'string' ? l : l.message || l.text || JSON.stringify(l)));
      return { logs, dashboardUrl: 'https://vercel.com/dashboard', status: 'ok' };
    }
    const errText = await res.text();
    return { logs: [`Vercel log API error: ${errText.substring(0, 200)}`], status: 'error' };
  } catch (e) {
    return { logs: [`Error fetching Vercel logs: ${e.message}`], status: 'error' };
  }
}
