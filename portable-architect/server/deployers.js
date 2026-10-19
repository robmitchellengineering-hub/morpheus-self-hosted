// Per-platform deployers. Live-deploy platforms make real API calls using
// credentials from the project's `connections` map (or server env). ZIP/CLI
// platforms return a downloadable package plus manual instructions.
//
// Each deployer: async (ctx) => result
//   ctx = { serviceId, type, projectName, files, connections }
//   result = { status, component?, label?, service?, url?, message?, configMessage?, sql?, zipBuffer? }
//
// status ∈ deployed | sql-ready | zip | integrated | error

import JSZip from 'jszip';

const slug = (name) => (name || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';

async function makeZip(files, extra = []) {
  const zip = new JSZip();
  for (const f of [...files, ...extra]) zip.file(f.path, f.content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function dockerExtras(projectName) {
  return [
    { path: 'Dockerfile', content: 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n' },
    { path: 'docker-compose.yml', content: `services:\n  app:\n    build: .\n    ports:\n      - "3000:3000"\n    env_file: .env\n    restart: unless-stopped\n` },
  ];
}

// ── Cloudflare Workers ──────────────────────────────────────────────────
async function cloudflare({ projectName, files, connections }) {
  const token = connections?.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const accountId = connections?.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) throw new Error('Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID');
  const worker = files.find((f) => /worker\.js$|index\.js$/.test(f.path)) || files[0];
  const name = slug(projectName);
  const fileName = worker.path.split('/').pop();
  const isModule = /export\s+default/.test(worker.content);
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`;
  const form = new FormData();
  if (isModule) {
    form.set('metadata', JSON.stringify({ main_module: fileName, compatibility_date: '2024-09-01' }));
    form.set(fileName, new Blob([worker.content], { type: 'application/javascript+module' }), fileName);
  } else {
    form.set('metadata', JSON.stringify({}));
    form.set('script', new Blob([worker.content], { type: 'application/javascript' }), 'script');
  }
  const res = await fetch(base, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.success) throw new Error(data.errors?.[0]?.message || 'Cloudflare upload failed');
  // Enable the workers.dev route
  await fetch(`${base}/subdomain`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) }).catch(() => {});
  const sub = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.json()).catch(() => ({}));
  const host = sub.result?.subdomain ? `${sub.result.subdomain}.workers.dev` : 'workers.dev';
  return { status: 'deployed', service: 'cloudflare-workers', url: `https://${name}.${host}`, message: 'Worker published to Cloudflare.' };
}

// ── Vercel ──────────────────────────────────────────────────────────────
async function vercel({ projectName, files, connections }) {
  const token = connections?.VERCEL_TOKEN || process.env.VERCEL_TOKEN;
  if (!token) throw new Error('Missing VERCEL_TOKEN');
  const body = {
    name: slug(projectName),
    target: 'production',
    files: files.map((f) => ({ file: f.path, data: Buffer.from(f.content).toString('base64') })),
    projectSettings: { framework: null },
  };
  const res = await fetch('https://api.vercel.com/v13/deployments', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || 'Vercel deploy failed');
  return { status: 'deployed', service: 'vercel', url: data.url ? `https://${data.url}` : null, message: 'Deployed to Vercel.' };
}

// ── Netlify (zip deploy) ────────────────────────────────────────────────
async function netlify({ projectName, files, connections }) {
  const token = connections?.NETLIFY_TOKEN || process.env.NETLIFY_TOKEN;
  const siteId = connections?.NETLIFY_SITE_ID || process.env.NETLIFY_SITE_ID;
  if (!token || !siteId) throw new Error('Missing NETLIFY_TOKEN / NETLIFY_SITE_ID');
  const zip = await makeZip(files);
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
    body: zip,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Netlify deploy failed');
  return { status: 'deployed', service: 'netlify', url: data.ssl_url || data.deploy_ssl_url || null, message: 'Deployed to Netlify.' };
}

// ── Supabase (run SQL migration) ────────────────────────────────────────
async function supabase({ projectName, files, connections }) {
  const token = connections?.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
  const ref = connections?.SUPABASE_PROJECT_REF || process.env.SUPABASE_PROJECT_REF;
  const sqlFile = files.find((f) => /schema\.sql$|migration.*\.sql$|init\.sql$/i.test(f.path));
  if (!sqlFile) return { status: 'sql-ready', service: 'supabase-pg', sql: null, message: 'No SQL migration file found in generated backend.' };
  if (!token || !ref) return { status: 'sql-ready', service: 'supabase-pg', sql: sqlFile.content, message: 'SQL ready — run manually in Supabase SQL editor.' };
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sqlFile.content }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { status: 'sql-ready', service: 'supabase-pg', sql: sqlFile.content, message: `SQL deploy failed: ${txt.slice(0, 200)}` };
  }
  return { status: 'deployed', service: 'supabase-pg', sql: sqlFile.content, message: 'SQL migration applied to Supabase.' };
}

// ── Render (create web service from git repo) ───────────────────────────
async function render({ projectName, files, connections }) {
  const key = connections?.RENDER_API_KEY || process.env.RENDER_API_KEY;
  const repo = connections?.RENDER_REPO_URL || process.env.RENDER_REPO_URL;
  if (!key) throw new Error('Missing RENDER_API_KEY');
  if (!repo) {
    const zip = await makeZip(files, dockerExtras(projectName));
    return { status: 'zip', service: 'render', zipBuffer: zip, message: 'No RENDER_REPO_URL set. Download the ZIP and connect a git repo in Render.', configMessage: 'Manual: push this ZIP to a git repo, then create a Web Service in Render pointing at it.' };
  }
  const res = await fetch('https://api.render.com/v1/services', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'web_service', name: slug(projectName), repo, branch: 'main', serviceDetails: { env: 'node', plan: 'free', buildCommand: 'npm ci', startCommand: 'node server.js' } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Render create failed');
  return { status: 'deployed', service: 'render', url: data.service?.dashboardUrl || null, message: 'Render web service created (first build in progress).' };
}

// ── Railway (ZIP + CLI; API is git-based) ────────────────────────────────
async function railway({ projectName, files }) {
  const zip = await makeZip(files);
  return {
    status: 'zip', service: 'railway', zipBuffer: zip,
    message: 'Railway deploys from git. Push the ZIP to a repo, then: railway up',
    configMessage: 'Manual: railway login | railway link <repo> | railway up',
  };
}

// ── Fly.io (fly.toml + Dockerfile + CLI) ─────────────────────────────────
async function fly({ projectName, files }) {
  const extras = [
    ...dockerExtras(projectName),
    { path: 'fly.toml', content: `app = '${slug(projectName)}'\nprimary_region = 'syd'\n[build]\n[http_service]\n  internal_port = 3000\n  force_https = true\n  auto_stop_machines = true\n  auto_start_machines = true\n` },
  ];
  const zip = await makeZip(files, extras);
  return {
    status: 'zip', service: 'fly', zipBuffer: zip,
    message: 'Fly.io needs flyctl. Download the ZIP, then: fly launch --dockerfile Dockerfile',
    configMessage: 'Manual: flyctl auth login | fly launch | fly deploy',
  };
}

// ── Docker (self-hosted) ─────────────────────────────────────────────────
async function docker({ projectName, files }) {
  const zip = await makeZip(files, dockerExtras(projectName));
  return { status: 'zip', service: 'self-hosted-docker', zipBuffer: zip, message: 'Download the ZIP, then: docker compose up --build', configMessage: 'Manual: unzip | docker compose up --build | app on :3000' };
}

// ── Standalone (Node) ────────────────────────────────────────────────────
async function standalone({ projectName, files }) {
  const zip = await makeZip(files);
  return { status: 'zip', service: 'standalone', zipBuffer: zip, message: 'Download the ZIP, then: npm ci && node server.js', configMessage: 'Manual: unzip | npm ci | node server.js' };
}

const DEPLOYERS = {
  'cloudflare-workers': cloudflare,
  'vercel': vercel,
  'netlify': netlify,
  'supabase-pg': supabase,
  'render': render,
  'railway': railway,
  'fly': fly,
  'self-hosted-docker': docker,
  'standalone': standalone,
};

export async function deploy(serviceId, ctx) {
  const fn = DEPLOYERS[serviceId];
  if (!fn) return { status: 'integrated', service: serviceId, message: 'Code-level integration (configured in generated backend).' };
  return fn(ctx);
}

// Best-effort log pointers. Live log tailing happens in each platform's
// dashboard; we return the dashboard URL plus any stored deploy messages.
export function getLogPointer(serviceId, connections = {}) {
  const acc = connections?.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const ref = connections?.SUPABASE_PROJECT_REF || process.env.SUPABASE_PROJECT_REF;
  const site = connections?.NETLIFY_SITE_ID || process.env.NETLIFY_SITE_ID;
  const map = {
    'cloudflare-workers': acc ? `https://dash.cloudflare.com/${acc}/workers/services` : 'https://dash.cloudflare.com',
    'vercel': 'https://vercel.com/dashboard',
    'netlify': site ? `https://app.netlify.com/sites/${site}` : 'https://app.netlify.com',
    'render': 'https://dashboard.render.com',
    'railway': 'https://railway.app/dashboard',
    'fly': 'https://fly.io/dashboard',
    'supabase-pg': ref ? `https://supabase.com/dashboard/project/${ref}` : 'https://supabase.com/dashboard',
  };
  return map[serviceId] || null;
}