// Ported from base44/functions/deployBackend/entry.ts.
//
// Deploys generated backend code to the chosen live targets. Handles ALL
// selected infrastructure components:
//   - API host: live-deploys to Cloudflare Workers/Vercel/Netlify/Railway/
//     Render/Fly.io; returns dashboard links + ZIP instructions for the
//     zip-based targets (self-hosted-docker, standalone).
//   - Database: executes SQL migrations on Supabase via Management API;
//     returns SQL + editor link for others.
//   - Auth/Storage/Cache: code-level integrations — returns dashboard links
//     for verification.
// Stores deploy metadata in backend/.deploy.json for log retrieval.
//
// Credential note: the original also fell back to Base44 platform-wide
// secrets (`secrets.get('CLOUDFLARE_API_TOKEN')` etc.) when a per-user
// connection wasn't set — but ONLY for Cloudflare (api_token, account_id)
// and Supabase (project_ref, access_token); the original never had a
// platform-secret fallback for Render/Vercel/Netlify/Railway/Fly here. A
// prior pass here dropped ALL platform-secret fallbacks, including the
// Cloudflare/Supabase ones the original genuinely had — leaving this file
// out of sync with getBackendLogs.js, which correctly ported those same
// `secrets.get(X)` calls to `process.env.X` (the self-hosted equivalent of
// Base44's house-wide secret store). Restored below so an operator who sets
// CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID/SUPABASE_PROJECT_REF/
// SUPABASE_ACCESS_TOKEN as server env vars gets the same deploy-time
// fallback that getBackendLogs.js already gives them at log-fetch time.
//
// Bug fix vs. original: the original referenced `userConnections` inside the
// `dryRun` branch before it was declared later in the function (a genuine
// ReferenceError in the source — `const userConnections` was temporal-dead-
// zoned at that point). This port loads userConnections before the dryRun
// check so dry-run credential validation actually works.
import { prisma } from '../db.js';
import { getServiceOption, getDashboardUrl, validateDeployCredentials } from '../lib/infrastructureComponents.js';
import { logUsage } from '../lib/projectUtils.js';
import { getGithubToken } from '../lib/github.js';
import { createRepo, pushFiles, ghHeaders, ghJson, encryptAndSetGithubSecret } from '../lib/github.js';
import { withRetry } from '../lib/healthCheck.js';
import crypto from 'node:crypto';
import { decodeConnections } from '../lib/connectionSecrets.js';

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
function sha1Hex(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

export default async function handler({ user, body }) {
  const { projectId, components } = body || {};
  if (!projectId || !components) throw Object.assign(new Error('projectId and components required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const files = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  const backendFiles = files.filter((f) => f.path.startsWith('backend/') && f.path !== 'backend/.plan.json' && f.path !== 'backend/.deploy.json');

  if (backendFiles.length === 0) throw Object.assign(new Error('No backend files to deploy. Generate backend first.'), { status: 400 });

  // Read per-user hosting credentials (moved above the dryRun check — see
  // note above about the original's ReferenceError bug).
  const settingsRow = await prisma.userSettings.findUnique({ where: { created_by_id: user.id } });
  const userConnections = decodeConnections(settingsRow?.connections);
  const supabaseRef = userConnections.supabase?.project_ref;

  // Dry-run mode: validate credentials and file structure without deploying.
  // Lets the user catch missing creds / missing entry point before wasting a deploy.
  if (body.dryRun) {
    const credCheck = validateDeployCredentials(components, userConnections);
    const hasEntryPoint = backendFiles.some((f) =>
      f.path === 'backend/src/index.ts' ||
      f.path === 'backend/index.ts' ||
      f.path === 'backend/server/index.js' ||
      f.path === 'backend/api/index.js' ||
      f.path === 'backend/worker.ts'
    );
    const sqlFiles = backendFiles.filter((f) => f.path.endsWith('.sql')).map((f) => f.path);
    const warnings = [];
    if (!hasEntryPoint) warnings.push('No entry point file found (expected src/index.ts, index.ts, server/index.js, or worker.ts)');
    warnings.push(...credCheck.missing.map((m) => `${m.label}: credentials missing — deploy will return ZIP/manual instructions instead of going live`));
    return {
      dryRun: true,
      components,
      fileCount: backendFiles.length,
      hasEntryPoint,
      sqlFiles,
      credentials: { valid: credCheck.valid, missing: credCheck.missing },
      warnings,
    };
  }

  // Read backend config (custom domain + API keys)
  const backendConfig = await prisma.backendConfig.findFirst({ where: { project_id: projectId, created_by_id: user.id } });
  const customDomain = backendConfig?.custom_domain || '';
  let activeKeyHashes = [];
  if (backendConfig?.api_keys) {
    try {
      const allKeys = JSON.parse(backendConfig.api_keys);
      activeKeyHashes = allKeys.filter((k) => k.active).map((k) => k.keyHash);
    } catch {
      // malformed api_keys JSON — treat as no active keys
    }
  }

  const results = [];

  // 1. Deploy API host
  const apiHostResult = await deployApiHost(components.api_host, project, backendFiles, userConnections, user.id);
  results.push({ component: 'api_host', ...apiHostResult });

  // 2. Deploy database (execute migrations)
  const dbResult = await deployDatabase(components.database, project, backendFiles, userConnections);
  results.push({ component: 'database', ...dbResult });

  // 3. Auth / Storage / Cache — code-level integrations, return dashboard links
  for (const compType of ['auth', 'file_storage', 'cache']) {
    const serviceId = components[compType];
    if (serviceId && serviceId !== 'none') {
      const service = getServiceOption(compType, serviceId);
      results.push({
        component: compType,
        status: 'integrated',
        service: serviceId,
        label: service?.label,
        url: getDashboardUrl(serviceId, supabaseRef),
        message: 'Integrated in generated code. Open the dashboard to verify tables/users/buckets exist.',
      });
    }
  }

  // Post-deploy health check: ping deployed URLs to verify they're live
  for (const r of results) {
    if (r.status === 'deployed' && r.url) {
      try {
        const healthRes = await fetch(r.url, {
          method: 'GET',
          signal: AbortSignal.timeout(8000),
          headers: { Accept: 'application/json, text/plain, */*' },
        });
        r.healthStatus = healthRes.status < 400 ? 'healthy' : 'unhealthy';
        r.healthStatusCode = healthRes.status;
      } catch (e) {
        // Async-build platforms (Railway/Render/Fly) may not be live yet — mark as pending
        const asyncServices = ['railway', 'render', 'fly'];
        r.healthStatus = asyncServices.includes(r.service) ? 'building' : 'unhealthy';
        r.healthError = e.message;
      }
    }
  }

  // Apply backend config (custom domain + API key env vars) to deployed services
  for (const r of results) {
    if (r.status === 'deployed' && r.service) {
      const configApplied = await applyBackendConfig(r, customDomain, activeKeyHashes, userConnections);
      if (configApplied.customDomain) r.customDomain = configApplied.customDomain;
      if (configApplied.apiKeysSet) r.apiKeysInjected = configApplied.apiKeysSet;
      if (configApplied.message) r.configMessage = configApplied.message;
    }
  }

  // Store deploy info for log retrieval
  const deployInfo = {
    timestamp: new Date().toISOString(),
    components,
    results,
    healthChecked: true,
    backendConfig: {
      customDomain,
      activeKeyCount: activeKeyHashes.length,
    },
    connections: {
      cloudflare: { account_id: userConnections.cloudflare?.account_id, script_name: apiHostResult.scriptName },
      supabase: { project_ref: supabaseRef },
      render: { service_id: userConnections.render?.service_id },
      vercel: { project_id: userConnections.vercel?.project_id, deployment_id: userConnections.vercel?.deployment_id },
      netlify: { site_id: userConnections.netlify?.site_id },
      railway: { token: userConnections.railway?.token ? 'configured' : undefined, project_id: results.find((r) => r.service === 'railway')?.railwayProjectId },
      fly: { api_token: userConnections.fly?.api_token ? 'configured' : undefined, app_name: results.find((r) => r.service === 'fly')?.flyAppName },
    },
  };

  const existingDeployFile = files.find((f) => f.path === 'backend/.deploy.json');
  if (existingDeployFile) {
    await prisma.projectFile.update({ where: { id: existingDeployFile.id }, data: { content: JSON.stringify(deployInfo, null, 2) } });
  } else {
    await prisma.projectFile.create({
      data: {
        created_by_id: user.id,
        project_id: projectId,
        path: 'backend/.deploy.json',
        content: JSON.stringify(deployInfo, null, 2),
        language: 'json',
      },
    });
  }

  await logUsage(user.id, 'compile', project.id, project.name, { phase: 'backend_deploy', components });

  return { results, deployInfo };
}

// --- API Host deployment ---

async function deployApiHost(serviceId, project, backendFiles, userConnections, userId) {
  const service = getServiceOption('api_host', serviceId);
  if (!service) return { status: 'error', service: serviceId, message: 'Unknown API host service' };

  const shouldRetry = (r) => r?.status === 'error' && !r?.message?.includes('not configured');

  if (serviceId === 'cloudflare-workers') {
    const { result } = await withRetry(() => deployCloudflare(project, backendFiles, userConnections), shouldRetry);
    return result;
  }
  if (serviceId === 'vercel') {
    const { result } = await withRetry(() => deployVercel(project, backendFiles, userConnections), shouldRetry);
    return result;
  }
  if (serviceId === 'netlify') {
    const { result } = await withRetry(() => deployNetlify(project, backendFiles, userConnections), shouldRetry);
    return result;
  }
  if (serviceId === 'railway') {
    const { result } = await withRetry(() => deployRailway(project, backendFiles, userConnections, userId), shouldRetry);
    return result;
  }
  if (serviceId === 'render') {
    const { result } = await withRetry(() => deployRender(project, backendFiles, userConnections, userId), shouldRetry);
    return result;
  }
  if (serviceId === 'fly') {
    const { result } = await withRetry(() => deployFly(project, backendFiles, userConnections, userId), shouldRetry);
    return result;
  }

  // For zip-based targets: return dashboard link + instructions
  return {
    status: 'zip',
    service: serviceId,
    label: service.label,
    url: getDashboardUrl(serviceId),
    message: `Download ZIP (button below) and deploy to ${service.label}. Open the dashboard to monitor.`,
  };
}

// --- Shared helper: push backend files to a fresh GitHub repo ---
// Railway, Render, and Fly.io all deploy from GitHub repos. This creates a
// private repo, pushes the backend code, and returns the repo info.

async function pushBackendToGithub(userId, project, backendFiles, extraFiles) {
  const accessToken = await getGithubToken(userId);
  const slug = project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 20) || 'morpheus-api';
  const repoName = `morpheus-deploy-${slug}-${Date.now()}`;
  // autoInit:false — repoName is always fresh (timestamped) — see pushFiles'
  // isNewRepo path for why this avoids the GitRPC::BadObjectState race that
  // was causing compile pushes to silently fail.
  const repo = await createRepo(accessToken, repoName, true, { autoInit: false });
  if (!repo?.full_name) throw new Error('Failed to create GitHub repo for deployment');

  const filesToPush = backendFiles
    .filter((f) => !f.path.endsWith('.plan.json') && !f.path.endsWith('.deploy.json'))
    .map((f) => ({ path: f.path.replace('backend/', ''), content: f.content }));

  if (extraFiles) filesToPush.push(...extraFiles);

  const { branch } = await pushFiles(accessToken, repo.full_name, filesToPush, 'Deploy from Morpheus', { isNewRepo: repo._isNewRepo });
  return { repoFullName: repo.full_name, repoUrl: repo.html_url, branch };
}

// --- Railway live deploy ---
// Pushes code to GitHub, then creates a Railway project + service from that repo.

async function deployRailway(project, backendFiles, userConnections, userId) {
  const token = userConnections.railway?.token;
  if (!token) {
    return { status: 'error', service: 'railway', message: 'Railway API token not configured. Set it in Settings → Connections.' };
  }

  let githubInfo;
  try {
    githubInfo = await pushBackendToGithub(userId, project, backendFiles);
  } catch (e) {
    return { status: 'error', service: 'railway', message: e.message };
  }

  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const projectName = (project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 25) || 'morpheus-api');

  try {
    // Step 1: Create a Railway project
    const projectRes = await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ query: `mutation { projectCreate(input: { name: "${projectName}" }) { project { id } } }` }),
    });
    const projectData = await projectRes.json();
    const railwayProjectId = projectData?.data?.projectCreate?.project?.id;
    if (!railwayProjectId) {
      const errMsg = JSON.stringify(projectData?.errors || projectData).substring(0, 200);
      return { status: 'error', service: 'railway', message: `Railway project creation failed: ${errMsg}`, url: githubInfo.repoUrl };
    }

    // Step 2: Create a service from the GitHub repo
    const serviceRes = await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        query: `mutation { serviceCreate(input: { projectId: "${railwayProjectId}", name: "${projectName}", source: { repo: "${githubInfo.repoFullName}" } }) { service { id } } }`,
      }),
    });
    const serviceData = await serviceRes.json();
    const serviceId = serviceData?.data?.serviceCreate?.service?.id;
    if (!serviceId) {
      const errMsg = JSON.stringify(serviceData?.errors || serviceData).substring(0, 200);
      return { status: 'error', service: 'railway', message: `Railway service creation failed: ${errMsg}. Make sure your Railway account is connected to GitHub.`, url: githubInfo.repoUrl };
    }

    return {
      status: 'deployed',
      service: 'railway',
      label: 'Railway',
      url: `https://railway.app/project/${railwayProjectId}`,
      dashboardUrl: getDashboardUrl('railway'),
      railwayProjectId,
      message: 'Code pushed to GitHub and Railway service created. Railway will auto-build and deploy. IMPORTANT: Set required env vars (DATABASE_URL, SUPABASE_URL, JWT_SECRET, etc.) in Railway → Variables before the build can succeed. Open the project to watch the build.',
      githubUrl: githubInfo.repoUrl,
    };
  } catch (e) {
    return { status: 'error', service: 'railway', message: `Railway deploy error: ${e.message}`, url: githubInfo?.repoUrl };
  }
}

// --- Render live deploy ---
// Pushes code to GitHub, then creates a Render web service from that repo.

async function deployRender(project, backendFiles, userConnections, userId) {
  const apiKey = userConnections.render?.api_key;
  if (!apiKey) {
    return { status: 'error', service: 'render', message: 'Render API key not configured. Set it in Settings → Connections.' };
  }

  let githubInfo;
  try {
    githubInfo = await pushBackendToGithub(userId, project, backendFiles);
  } catch (e) {
    return { status: 'error', service: 'render', message: e.message };
  }

  const authHeaders = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const serviceName = (project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 25) || 'morpheus-api');

  try {
    const res = await fetch('https://api.render.com/v1/services', {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        type: 'web',
        name: serviceName,
        repo: `https://github.com/${githubInfo.repoFullName}`,
        branch: githubInfo.branch,
        autoDeploy: 'yes',
        serviceDetails: {
          renderType: 'docker',
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      return { status: 'error', service: 'render', message: `Render service creation failed (${res.status}): ${err.substring(0, 200)}`, url: githubInfo.repoUrl };
    }

    const data = await res.json();
    const serviceUrl = data.service?.url || data.url;

    return {
      status: 'deployed',
      service: 'render',
      label: 'Render',
      url: serviceUrl,
      dashboardUrl: getDashboardUrl('render'),
      message: 'Code pushed to GitHub and Render service created. Render will auto-build the Dockerfile and deploy. IMPORTANT: Set required env vars (DATABASE_URL, SUPABASE_URL, JWT_SECRET, etc.) in Render → Environment before the build can succeed. Check the dashboard for build progress.',
      githubUrl: githubInfo.repoUrl,
    };
  } catch (e) {
    return { status: 'error', service: 'render', message: `Render deploy error: ${e.message}`, url: githubInfo?.repoUrl };
  }
}

// --- Fly.io live deploy ---
// Pushes code + a deploy workflow to GitHub, then triggers the workflow.
// The workflow uses flyctl to build and deploy to Fly.io.

async function deployFly(project, backendFiles, userConnections, userId) {
  const apiToken = userConnections.fly?.api_token;
  if (!apiToken) {
    return { status: 'error', service: 'fly', message: 'Fly.io API token not configured. Set it in Settings → Connections.' };
  }

  // Generate the GitHub Action workflow that deploys to Fly.io
  const appName = (project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 25) || 'morpheus-api');
  const flyWorkflow = `name: Deploy to Fly.io

on:
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: |
          if [ ! -f fly.toml ]; then
            echo "No fly.toml found — creating default"
            cat > fly.toml <<EOF
          app = "${appName}"
          [build]
          [http_service]
            internal_port = 3000
            force_https = true
            auto_stop_machines = true
            auto_start_machines = true
          EOF
          fi
          flyctl deploy --remote-only --ha=false
        env:
          FLY_API_TOKEN: \${{ secrets.FLY_API_TOKEN }}
`;

  let githubInfo;
  try {
    githubInfo = await pushBackendToGithub(userId, project, backendFiles, [
      { path: '.github/workflows/fly-deploy.yml', content: flyWorkflow },
    ]);
  } catch (e) {
    return { status: 'error', service: 'fly', message: e.message };
  }

  try {
    // Set the FLY_API_TOKEN as a GitHub secret (encrypted with the repo's
    // public key — GitHub rejects raw values sent as encrypted_value).
    const ghToken = await getGithubToken(userId);
    const secretResult = await encryptAndSetGithubSecret(ghToken, githubInfo.repoFullName, 'FLY_API_TOKEN', apiToken);
    if (!secretResult.ok) {
      return { status: 'error', service: 'fly', message: `Failed to set FLY_API_TOKEN secret: ${secretResult.error}. Open the repo → Settings → Secrets and add it manually.`, url: githubInfo.repoUrl };
    }
    const h = ghHeaders(ghToken);

    // Wait for workflow registration, then trigger it
    let workflowId = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));
      const wfRes = await fetch(`https://api.github.com/repos/${githubInfo.repoFullName}/actions/workflows`, { headers: h });
      const wfData = await ghJson(wfRes);
      const wf = (wfData.workflows || []).find((w) => w.path === '.github/workflows/fly-deploy.yml');
      if (wf) { workflowId = wf.id; break; }
    }

    if (!workflowId) {
      return {
        status: 'deployed',
        service: 'fly',
        label: 'Fly.io',
        url: undefined,
        dashboardUrl: getDashboardUrl('fly'),
        message: 'Code and deploy workflow pushed to GitHub. Open the repo and manually trigger the "Deploy to Fly.io" workflow.',
        githubUrl: githubInfo.repoUrl,
      };
    }

    // Trigger the workflow — verify the dispatch succeeded
    const dispatchRes = await fetch(`https://api.github.com/repos/${githubInfo.repoFullName}/actions/workflows/${workflowId}/dispatches`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ ref: githubInfo.branch }),
    });
    if (!dispatchRes.ok) {
      const err = await ghJson(dispatchRes);
      return { status: 'error', service: 'fly', message: `Failed to trigger deploy workflow: ${err.message || dispatchRes.status}. Open the Actions tab and trigger it manually.`, url: githubInfo.repoUrl };
    }

    return {
      status: 'deployed',
      service: 'fly',
      label: 'Fly.io',
      url: undefined,
      dashboardUrl: getDashboardUrl('fly'),
      flyAppName: appName,
      message: 'Code pushed to GitHub and Fly.io deploy workflow triggered. The Action will build and deploy via flyctl. Check the Actions tab for progress.',
      githubUrl: githubInfo.repoUrl,
    };
  } catch (e) {
    return { status: 'error', service: 'fly', message: `Fly.io deploy error: ${e.message}`, url: githubInfo?.repoUrl };
  }
}

// --- Vercel live deploy ---
// Uploads each file to Vercel's file API (SHA-256 digest), then creates a
// production deployment referencing those file SHAs.

async function deployVercel(project, backendFiles, userConnections) {
  const token = userConnections.vercel?.token;
  if (!token) {
    return {
      status: 'error',
      service: 'vercel',
      message: 'Vercel token not configured. Set it in Settings → Connections.',
    };
  }

  const teamId = userConnections.vercel?.team_id;
  const teamParam = teamId ? `?teamId=${teamId}` : '';
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Strip 'backend/' prefix and skip metadata files
  const filesToDeploy = backendFiles
    .filter((f) => !f.path.endsWith('.plan.json') && !f.path.endsWith('.deploy.json'))
    .map((f) => ({ path: f.path.replace('backend/', ''), content: f.content }));

  if (filesToDeploy.length === 0) {
    return { status: 'error', service: 'vercel', message: 'No deployable files found.' };
  }

  // Step 1: Upload each file to get its SHA digest
  const fileSHAs = [];
  for (const file of filesToDeploy) {
    const digest = sha256Hex(file.content);
    const res = await fetch(`https://api.vercel.com/v2/files${teamParam}`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/octet-stream', 'x-vercel-digest': digest },
      body: file.content,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      return { status: 'error', service: 'vercel', message: `Vercel file upload failed (${res.status}): ${err.substring(0, 200)}` };
    }
    fileSHAs.push({ file: file.path, sha: digest });
  }

  // Step 2: Create production deployment
  const projectName = (project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 25) || 'morpheus-api');

  const deployRes = await fetch(`https://api.vercel.com/v13/deployments${teamParam}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: projectName,
      files: fileSHAs,
      target: 'production',
      projectSettings: { framework: null },
    }),
  });

  if (!deployRes.ok) {
    const err = await deployRes.text().catch(() => '');
    return { status: 'error', service: 'vercel', message: `Vercel deploy failed (${deployRes.status}): ${err.substring(0, 200)}` };
  }

  const deployData = await deployRes.json();
  const url = deployData.url ? `https://${deployData.url}` : undefined;

  return {
    status: 'deployed',
    service: 'vercel',
    label: 'Vercel',
    url,
    dashboardUrl: getDashboardUrl('vercel'),
    message: 'Deployed to Vercel production. Click the URL to test the API.',
  };
}

// --- Netlify live deploy ---
// Creates a site (if no site_id), then uses the atomic deploy API: send all
// file SHA-1 hashes, Netlify responds with which files need uploading, then
// upload each required file individually.

async function deployNetlify(project, backendFiles, userConnections) {
  const token = userConnections.netlify?.token;
  if (!token) {
    return {
      status: 'error',
      service: 'netlify',
      message: 'Netlify token not configured. Set it in Settings → Connections.',
    };
  }

  const authHeaders = { Authorization: `Bearer ${token}` };

  // Strip 'backend/' prefix and skip metadata files
  const filesToDeploy = backendFiles
    .filter((f) => !f.path.endsWith('.plan.json') && !f.path.endsWith('.deploy.json'))
    .map((f) => ({ path: f.path.replace('backend/', ''), content: f.content }));

  if (filesToDeploy.length === 0) {
    return { status: 'error', service: 'netlify', message: 'No deployable files found.' };
  }

  // Compute SHA-1 for each file
  const fileHashMap = {};
  for (const file of filesToDeploy) {
    const hash = sha1Hex(file.content);
    fileHashMap[hash] = { path: file.path, hash, content: file.content };
  }

  // Step 1: Get or create a site
  let siteId = userConnections.netlify?.site_id;
  let siteUrl;
  if (!siteId) {
    const siteRes = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: (project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 25) || 'morpheus-api') }),
    });
    if (!siteRes.ok) {
      const err = await siteRes.text().catch(() => '');
      return { status: 'error', service: 'netlify', message: `Netlify site creation failed (${siteRes.status}): ${err.substring(0, 200)}` };
    }
    const siteData = await siteRes.json();
    siteId = siteData.id;
    siteUrl = siteData.ssl_url || siteData.url;
  }

  // Step 2: Create a deploy with file hashes
  const filesBody = {};
  for (const file of filesToDeploy) {
    filesBody[file.path] = sha1Hex(file.content);
  }

  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: filesBody }),
  });

  if (!deployRes.ok) {
    const err = await deployRes.text().catch(() => '');
    return { status: 'error', service: 'netlify', message: `Netlify deploy creation failed (${deployRes.status}): ${err.substring(0, 200)}` };
  }

  const deployData = await deployRes.json();
  const deployId = deployData.id;

  // Step 3: Upload required files
  const required = deployData.required || [];
  for (const hash of required) {
    const file = fileHashMap[hash];
    if (!file) continue;
    const uploadRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deployId}/files/${encodeURIComponent(file.path)}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
      body: file.content,
    });
    if (!uploadRes.ok) {
      const err = await uploadRes.text().catch(() => '');
      return { status: 'error', service: 'netlify', message: `Netlify file upload failed for ${file.path}: ${err.substring(0, 200)}` };
    }
  }

  // Fetch the final deploy state to get the URL
  let finalUrl = siteUrl;
  try {
    const finalRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deployId}`, { headers: authHeaders });
    if (finalRes.ok) {
      const finalData = await finalRes.json();
      finalUrl = finalData.ssl_url || finalData.url || finalUrl;
    }
  } catch {
    // keep siteUrl as the fallback
  }

  return {
    status: 'deployed',
    service: 'netlify',
    label: 'Netlify',
    url: finalUrl,
    dashboardUrl: getDashboardUrl('netlify'),
    message: 'Deployed to Netlify. Click the URL to test the API.',
  };
}

async function deployCloudflare(project, backendFiles, userConnections) {
  // process.env fallback restored — see credential note at top of file.
  const apiToken = userConnections.cloudflare?.api_token || process.env.CLOUDFLARE_API_TOKEN;
  const accountId = userConnections.cloudflare?.account_id || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken || !accountId) {
    return {
      status: 'error',
      service: 'cloudflare-workers',
      message: 'Cloudflare credentials not configured. Set API token + account ID in Settings → Connections.',
    };
  }

  const mainFile = backendFiles.find((f) => f.path === 'backend/src/index.ts' || f.path === 'backend/index.ts' || f.path === 'backend/worker.ts')
    || backendFiles.find((f) => f.path.endsWith('index.ts') || f.path.endsWith('worker.ts'));
  if (!mainFile) return { status: 'error', service: 'cloudflare-workers', message: 'No main worker file found (expected src/index.ts).' };

  const scriptName = (project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 25) || 'morpheus-api') + '-' + Date.now().toString(36);

  const formData = new FormData();
  const metadata = JSON.stringify({ main_module: 'index.ts', compatibility_date: '2024-09-01' });
  formData.append('metadata', new Blob([metadata], { type: 'application/json' }), 'metadata.json');
  formData.append('index.ts', new Blob([mainFile.content], { type: 'application/javascript+module' }), 'index.ts');

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}` },
    body: formData,
  });

  const data = await res.json();
  if (!data.success) {
    const errMsg = data.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    return { status: 'error', service: 'cloudflare-workers', message: 'Cloudflare deploy failed: ' + errMsg };
  }

  return {
    status: 'deployed',
    service: 'cloudflare-workers',
    label: 'Cloudflare Workers',
    url: `https://${scriptName}.${accountId.substring(0, 8)}.workers.dev`,
    dashboardUrl: getDashboardUrl('cloudflare-workers'),
    scriptName,
    message: 'Worker deployed live. Click the URL to test the API.',
  };
}

// --- Database deployment ---

async function deployDatabase(serviceId, project, backendFiles, userConnections) {
  const service = getServiceOption('database', serviceId);
  if (!service) return { status: 'error', service: serviceId, message: 'Unknown database service' };

  const sqlFiles = backendFiles.filter((f) => f.path.endsWith('.sql'));
  const fullSql = sqlFiles.map((f) => `-- ${f.path}\n${f.content}`).join('\n\n');

  if (serviceId === 'supabase-pg') {
    return await deploySupabaseDb(fullSql, sqlFiles, userConnections);
  }

  // For other databases: return SQL + dashboard link for manual execution
  const editorLinks = {
    neon: 'https://console.neon.tech',
    turso: 'https://app.turso.tech',
    planetscale: 'https://app.planetscale.com',
  };

  return {
    status: 'sql-ready',
    service: serviceId,
    label: service.label,
    sql: fullSql,
    url: editorLinks[serviceId] || getDashboardUrl(serviceId),
    sqlFiles: sqlFiles.map((f) => f.path),
    message: `SQL migration ready. Open the ${service.label} SQL editor (link above), paste the SQL, and run it to create tables.`,
  };
}

// --- Apply backend config (custom domain + API keys) to a deployed service ---
// Cloudflare Workers: sets API_KEYS secret + configures custom domain route.
// Vercel: sets env var + adds custom domain.
// Others: returns instructions (the user applies manually).
async function applyBackendConfig(result, customDomain, activeKeyHashes, userConnections) {
  const keyList = activeKeyHashes.join(',');
  const hasKeys = keyList.length > 0;
  const hasDomain = customDomain.length > 0;
  if (!hasKeys && !hasDomain) return {};

  const service = result.service;
  const messages = [];

  // --- Cloudflare Workers ---
  if (service === 'cloudflare-workers') {
    // process.env fallback restored — see credential note at top of file.
    const apiToken = userConnections.cloudflare?.api_token || process.env.CLOUDFLARE_API_TOKEN;
    const accountId = userConnections.cloudflare?.account_id || process.env.CLOUDFLARE_ACCOUNT_ID;
    const scriptName = result.scriptName;
    if (!apiToken || !accountId || !scriptName) return {};

    // Set API_KEYS as a Worker secret
    if (hasKeys) {
      try {
        const secretRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/secrets`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'API_KEYS', text: keyList, type: 'secret_text' }),
        });
        const secretData = await secretRes.json();
        if (secretData.success) {
          messages.push('API keys injected as Worker secret');
        } else {
          messages.push(`API key injection failed: ${secretData.errors?.[0]?.message || 'unknown'}`);
        }
      } catch (e) {
        messages.push(`API key injection error: ${e.message}`);
      }
    }

    // Configure custom domain
    if (hasDomain) {
      try {
        const domainRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ environment: 'production', hostname: customDomain, service: scriptName, zone_id: userConnections.cloudflare?.zone_id || '' }),
        });
        const domainData = await domainRes.json();
        if (domainData.success) {
          messages.push(`Custom domain ${customDomain} attached`);
        } else {
          messages.push(`Custom domain setup: ${domainData.errors?.[0]?.message || 'add the domain in Cloudflare dashboard'}`);
        }
      } catch (e) {
        messages.push(`Custom domain error: ${e.message}`);
      }
    }

    return {
      customDomain: hasDomain ? customDomain : undefined,
      apiKeysSet: hasKeys,
      message: messages.join('; ') || undefined,
    };
  }

  // --- Vercel ---
  if (service === 'vercel') {
    const token = userConnections.vercel?.token;
    const teamId = userConnections.vercel?.team_id;
    const teamParam = teamId ? `?teamId=${teamId}` : '';
    if (!token) return {};
    // Vercel needs a project_id to set env vars / domains; we may not have one for ad-hoc deploys
    const projectId = userConnections.vercel?.project_id;
    if (!projectId) {
      return { message: hasDomain ? `Set API_KEYS env var + add domain ${customDomain} in Vercel dashboard` : 'Set API_KEYS env var in Vercel dashboard' };
    }

    if (hasKeys) {
      try {
        await fetch(`https://api.vercel.com/v9/projects/${projectId}/env${teamParam}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'API_KEYS', value: keyList, type: 'encrypted', target: ['production'] }),
        });
        messages.push('API_KEYS env var set');
      } catch (e) {
        messages.push(`API key env var error: ${e.message}`);
      }
    }

    if (hasDomain) {
      try {
        const domainRes = await fetch(`https://api.vercel.com/v9/projects/${projectId}/domains${teamParam}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: customDomain }),
        });
        if (domainRes.ok) {
          messages.push(`Custom domain ${customDomain} added`);
        } else {
          const d = await domainRes.json().catch(() => ({}));
          messages.push(`Domain setup: ${d.error?.message || 'add in Vercel dashboard'}`);
        }
      } catch (e) {
        messages.push(`Domain error: ${e.message}`);
      }
    }

    return {
      customDomain: hasDomain ? customDomain : undefined,
      apiKeysSet: hasKeys,
      message: messages.join('; ') || undefined,
    };
  }

  // --- Render / Railway / Fly / Netlify / others: return platform-specific instructions ---
  return getManualConfigInstructions(service, customDomain, hasDomain, keyList, hasKeys, userConnections);
}

// Build platform-specific manual configuration instructions for services that
// don't support automated domain/env-var API configuration. Returns a concise
// but actionable message with dashboard deep-links so the user knows exactly
// where to go and what to do.
function getManualConfigInstructions(service, customDomain, hasDomain, keyList, hasKeys, userConnections) {
  const keyPreview = keyList.substring(0, 32) + '...';
  const steps = [];

  if (service === 'render') {
    const serviceId = userConnections.render?.service_id;
    const baseUrl = serviceId ? `https://dashboard.render.com/web/${serviceId}` : 'https://dashboard.render.com';
    if (hasKeys) steps.push(`Env: ${baseUrl} → Environment → Add API_KEYS=${keyPreview}`);
    if (hasDomain) steps.push(`Domain: ${baseUrl} → Settings → Custom Domains → Add ${customDomain} (CNAME → your-service.onrender.com)`);
  } else if (service === 'railway') {
    const baseUrl = 'https://railway.app/dashboard';
    if (hasKeys) steps.push(`Env: ${baseUrl} → your project → Variables → Add API_KEYS=${keyPreview}`);
    if (hasDomain) steps.push(`Domain: ${baseUrl} → your service → Settings → Networking → Generate Domain or Custom Domain ${customDomain}`);
  } else if (service === 'fly') {
    const appName = userConnections.fly?.app_name || 'your-app';
    const baseUrl = `https://fly.io/apps/${appName}`;
    if (hasKeys) steps.push(`Env: flyctl secrets set API_KEYS="${keyPreview}" OR ${baseUrl} → Secrets`);
    if (hasDomain) steps.push(`Domain: flyctl certs add ${customDomain} OR ${baseUrl} → Certificates (CNAME → ${appName}.fly.dev)`);
  } else if (service === 'netlify') {
    const siteId = userConnections.netlify?.site_id;
    const baseUrl = siteId ? `https://app.netlify.com/sites/${siteId}` : 'https://app.netlify.com';
    if (hasKeys) steps.push(`Env: ${baseUrl} → Site settings → Environment variables → Add API_KEYS=${keyPreview}`);
    if (hasDomain) steps.push(`Domain: ${baseUrl} → Domain settings → Add custom domain ${customDomain} (CNAME → your-site.netlify.app)`);
  } else if (service === 'supabase-pg') {
    const ref = userConnections.supabase?.project_ref;
    const baseUrl = ref ? `https://supabase.com/dashboard/project/${ref}` : 'https://supabase.com/dashboard';
    if (hasKeys) steps.push(`Edge fn secrets: ${baseUrl}/functions → your fn → Secrets → API_KEYS=${keyPreview}`);
    if (hasDomain) steps.push(`Domain: ${baseUrl}/functions → your fn → Custom domain → ${customDomain} (CNAME → <fn-id>.supabase.co)`);
  } else {
    // Generic fallback
    if (hasKeys) steps.push(`Set env var API_KEYS=${keyPreview}`);
    if (hasDomain) steps.push(`Add custom domain ${customDomain}`);
  }

  return {
    customDomain: hasDomain ? customDomain : undefined,
    apiKeysSet: hasKeys,
    message: steps.length ? `Manual: ${steps.join(' | ')}` : undefined,
  };
}

async function deploySupabaseDb(fullSql, sqlFiles, userConnections) {
  // process.env fallback restored — see credential note at top of file.
  const projectRef = userConnections.supabase?.project_ref || process.env.SUPABASE_PROJECT_REF;
  const accessToken = userConnections.supabase?.access_token || process.env.SUPABASE_ACCESS_TOKEN;

  if (!projectRef) {
    return {
      status: 'error',
      service: 'supabase-pg',
      message: 'Supabase project ref not configured. Set it in Settings → Connections.',
    };
  }

  if (!accessToken) {
    return {
      status: 'sql-ready',
      service: 'supabase-pg',
      label: 'Supabase Postgres',
      sql: fullSql,
      url: `https://supabase.com/dashboard/project/${projectRef}/sql/new`,
      sqlFiles: sqlFiles.map((f) => f.path),
      message: 'Supabase access token not set. Open the SQL editor (link above) and paste the migration to create tables.',
    };
  }

  // Execute SQL via Supabase Management API
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: fullSql }),
    });

    if (res.ok) {
      return {
        status: 'deployed',
        service: 'supabase-pg',
        label: 'Supabase Postgres',
        url: `https://supabase.com/dashboard/project/${projectRef}`,
        sqlFiles: sqlFiles.map((f) => f.path),
        message: 'SQL migrations executed successfully. Tables created on Supabase. Open the dashboard to verify.',
      };
    }
    const errText = await res.text();
    return {
      status: 'error',
      service: 'supabase-pg',
      message: `Supabase SQL execution failed: ${errText.substring(0, 200)}`,
      sql: fullSql,
      url: `https://supabase.com/dashboard/project/${projectRef}/sql/new`,
    };
  } catch {
    return {
      status: 'sql-ready',
      service: 'supabase-pg',
      sql: fullSql,
      url: `https://supabase.com/dashboard/project/${projectRef}/sql/new`,
      message: 'SQL execution error. Open the SQL editor (link above) and paste the migration manually.',
    };
  }
}
