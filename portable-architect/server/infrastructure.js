// Infrastructure component catalog — framework-agnostic. Presents the same
// choices the Morpheus Architect offers, so any standalone app can configure
// its backend stack and check deploy readiness from configured connections.

export const COMPONENTS = [
  {
    type: 'api_host',
    label: 'API Host',
    description: 'Where your server / API runs',
    required: true,
    options: [
      { id: 'cloudflare-workers', label: 'Cloudflare Workers', freeTier: '100k req/day, free', deployType: 'live' },
      { id: 'vercel', label: 'Vercel', freeTier: '100 GB bandwidth, free', deployType: 'live' },
      { id: 'netlify', label: 'Netlify', freeTier: '100 GB bandwidth, free', deployType: 'live' },
      { id: 'railway', label: 'Railway', freeTier: '$5 credit/mo trial', deployType: 'live' },
      { id: 'render', label: 'Render', freeTier: '750 hrs/mo free web service', deployType: 'live' },
      { id: 'fly', label: 'Fly.io', freeTier: '3 shared-cpu VMs, free', deployType: 'live' },
      { id: 'self-hosted-docker', label: 'Self-Hosted (Docker)', freeTier: 'Your own server', deployType: 'zip' },
      { id: 'standalone', label: 'Standalone (Node)', freeTier: 'Any server with Node', deployType: 'zip' },
    ],
  },
  {
    type: 'database',
    label: 'Database',
    description: 'Where your data lives',
    required: true,
    options: [
      { id: 'supabase-pg', label: 'Supabase Postgres', freeTier: '500 MB, free', deployType: 'sql-live' },
      { id: 'neon', label: 'Neon Postgres', freeTier: '0.5 GB, free', deployType: 'sql-manual' },
      { id: 'turso', label: 'Turso (SQLite)', freeTier: '9 GB, free', deployType: 'sql-manual' },
      { id: 'planetscale', label: 'PlanetScale (MySQL)', freeTier: '1 GB, free', deployType: 'sql-manual' },
    ],
  },
  {
    type: 'auth',
    label: 'Auth',
    description: 'How users sign in',
    required: false,
    options: [
      { id: 'supabase-auth', label: 'Supabase Auth', freeTier: '50k MAU, free', deployType: 'code' },
      { id: 'clerk', label: 'Clerk', freeTier: '10k MAU, free', deployType: 'code' },
      { id: 'builtin', label: 'Built-in (JWT)', freeTier: 'Included in backend', deployType: 'code' },
    ],
  },
  {
    type: 'file_storage',
    label: 'File Storage',
    description: 'Where uploads live',
    required: false,
    options: [
      { id: 'supabase-storage', label: 'Supabase Storage', freeTier: '1 GB, free', deployType: 'code' },
      { id: 'r2', label: 'Cloudflare R2', freeTier: '10 GB, free', deployType: 'code' },
      { id: 'local', label: 'Local disk', freeTier: 'Your server', deployType: 'code' },
    ],
  },
  {
    type: 'cache',
    label: 'Cache',
    description: 'In-memory / rate-limit store',
    required: false,
    options: [
      { id: 'upstash', label: 'Upstash Redis', freeTier: '10k cmds/day, free', deployType: 'code' },
      { id: 'none', label: 'None', freeTier: '—', deployType: 'code' },
    ],
  },
];

export const DEFAULT_COMPONENTS = {
  api_host: 'cloudflare-workers',
  database: 'supabase-pg',
  auth: 'supabase-auth',
  file_storage: 'supabase-storage',
  cache: 'none',
};

// Env var names each service needs. Values may come from the project's
// `connections` map or the server process env (checked in that order).
export const REQUIRED_CREDENTIALS = {
  'cloudflare-workers': ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
  'vercel': ['VERCEL_TOKEN'],
  'netlify': ['NETLIFY_TOKEN', 'NETLIFY_SITE_ID'],
  'railway': ['RAILWAY_TOKEN'],
  'render': ['RENDER_API_KEY'],
  'fly': ['FLY_API_TOKEN'],
  'supabase-pg': ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF'],
  'supabase-auth': ['SUPABASE_URL', 'SUPABASE_ANON_KEY'],
  'supabase-storage': ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'],
  'r2': ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY', 'R2_SECRET_KEY'],
  'upstash': ['UPSTASH_REDIS_URL'],
  'clerk': ['CLERK_SECRET_KEY'],
};

export function getServiceOption(type, id) {
  const comp = COMPONENTS.find((c) => c.type === type);
  return comp?.options.find((o) => o.id === id);
}

export function hasCredentials(serviceId, connections = {}) {
  const keys = REQUIRED_CREDENTIALS[serviceId];
  if (!keys) return true;
  return keys.every((k) => {
    const v = connections?.[k] ?? process.env[k];
    return v && String(v).trim() !== '';
  });
}

export function getDeployExpectation(serviceId, connections = {}) {
  const opt = COMPONENTS.flatMap((c) => c.options).find((o) => o.id === serviceId);
  const dt = opt?.deployType || 'code';
  if (dt === 'live' || dt === 'sql-live') {
    return hasCredentials(serviceId, connections)
      ? { type: 'live', label: dt === 'sql-live' ? 'Live SQL deploy ready' : 'Live deploy ready' }
      : { type: 'needs-creds', label: 'Needs credentials' };
  }
  if (dt === 'sql-manual') return { type: 'sql-manual', label: 'SQL ready (manual run)' };
  if (dt === 'zip') return { type: 'zip', label: 'ZIP deploy (manual)' };
  return { type: 'code', label: 'Integrated in code' };
}