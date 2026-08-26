// Infrastructure component definitions for multi-target backend generation.
// The plan identifies which components the backend needs; each component has
// a list of free-tier service options. The user can override the plan's suggestions.

export interface ServiceOption {
  id: string;
  label: string;
  freeTier: string;
  codegenHint: string;
  deployType?: 'live' | 'zip';
  secrets?: string[];
  setupUrl?: string;
  setupInstructions?: string;
}

export interface InfrastructureComponent {
  type: string;
  label: string;
  description: string;
  required: boolean;
  options: ServiceOption[];
}

export const COMPONENTS: InfrastructureComponent[] = [
  {
    type: 'api_host',
    label: 'API Hosting',
    description: 'Where your API server runs',
    required: true,
    options: [
      {
        id: 'cloudflare-workers',
        label: 'Cloudflare Workers',
        freeTier: '100k req/day',
        deployType: 'live',
        secrets: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
        setupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
        setupInstructions: 'Cloudflare → My Profile → API Tokens → Create token with "Edit Workers" permission',
        codegenHint: 'Single-file Cloudflare Worker using Hono framework. All server code in src/index.ts (ES module export default). Include wrangler.toml. No Node.js built-ins — use Web APIs only.'
      },
      {
        id: 'vercel',
        label: 'Vercel',
        freeTier: '100GB bandwidth',
        deployType: 'live',
        secrets: ['VERCEL_TOKEN'],
        setupUrl: 'https://vercel.com/account/tokens',
        setupInstructions: 'Vercel → Account Settings → Tokens → Create token',
        codegenHint: 'Node.js backend as Vercel serverless functions in api/ directory (each file exports a default handler). Include vercel.json with rewrites, package.json. Functions are stateless.'
      },
      {
        id: 'netlify',
        label: 'Netlify',
        freeTier: '100GB bandwidth',
        deployType: 'live',
        secrets: ['NETLIFY_TOKEN'],
        setupUrl: 'https://app.netlify.com/user/applications',
        setupInstructions: 'Netlify → User Settings → Applications → New access token',
        codegenHint: 'Node.js backend as Netlify serverless functions in netlify/functions/ directory (each file exports a handler). Include netlify.toml, package.json.'
      },
      {
        id: 'railway',
        label: 'Railway',
        freeTier: '$5 credit/mo',
        deployType: 'live',
        secrets: ['RAILWAY_TOKEN'],
        setupUrl: 'https://railway.app/account/tokens',
        setupInstructions: 'Railway → Account Settings → Tokens → Generate token. Connect your Railway account to GitHub for auto-deploy.',
        codegenHint: 'Node.js Express server with Dockerfile, railway.json, package.json. Railway auto-detects Dockerfile. Include start command.'
      },
      {
        id: 'render',
        label: 'Render',
        freeTier: '750h/mo',
        deployType: 'live',
        secrets: ['RENDER_API_KEY'],
        setupUrl: 'https://dashboard.render.com/u/settings',
        setupInstructions: 'Render → Account Settings → API Keys → Create API key. Connect your Render account to GitHub for auto-deploy.',
        codegenHint: 'Node.js Express server with Dockerfile, render.yaml, package.json. Include start command in render.yaml.'
      },
      {
        id: 'fly',
        label: 'Fly.io',
        freeTier: '3 shared VMs',
        deployType: 'live',
        secrets: ['FLY_API_TOKEN'],
        setupUrl: 'https://fly.io/app/personal-access-tokens',
        setupInstructions: 'Fly.io → Account → Access Tokens → Create token. GitHub connection required for deploy.',
        codegenHint: 'Node.js Express server with Dockerfile, fly.toml, package.json. Include internal_port setting.'
      },
      {
        id: 'self-hosted-docker',
        label: 'Self-Hosted Docker',
        freeTier: 'Your server',
        deployType: 'zip',
        codegenHint: 'docker-compose.yml with Node.js Express API service. Include Dockerfile, server/index.js, package.json, .env.example. API on port 3000.'
      },
      {
        id: 'standalone',
        label: 'Standalone Node',
        freeTier: 'npm start',
        deployType: 'zip',
        codegenHint: 'Node.js Express server (server/index.js) serving static frontend from public/ AND API routes. Include package.json, .env.example. Port 3000. Single process, no Docker.'
      },
    ]
  },
  {
    type: 'database',
    label: 'Database',
    description: 'Where your data is stored',
    required: true,
    options: [
      {
        id: 'supabase-pg',
        label: 'Supabase Postgres',
        freeTier: '500MB, 50k MAU',
        codegenHint: 'Connect to Supabase Postgres via @supabase/supabase-js client. Use process.env.SUPABASE_URL and process.env.SUPABASE_SERVICE_ROLE_KEY. Generate SQL migrations in migrations/ for table creation and RLS policies.'
      },
      {
        id: 'neon',
        label: 'Neon Postgres',
        freeTier: '0.5GB, 100 compute hrs',
        codegenHint: 'Connect to Neon Postgres via pg or @neondatabase/serverless driver. Use process.env.DATABASE_URL (postgres connection string). Generate SQL migrations in migrations/.'
      },
      {
        id: 'turso',
        label: 'Turso (SQLite)',
        freeTier: '9GB, 500 DBs',
        codegenHint: 'Connect to Turso via @libsql/client. Use process.env.TURSO_DATABASE_URL and process.env.TURSO_AUTH_TOKEN. Generate schema in migrations/ using SQLite-compatible SQL.'
      },
      {
        id: 'planetscale',
        label: 'PlanetScale MySQL',
        freeTier: '5GB',
        codegenHint: 'Connect to PlanetScale via mysql2 driver. Use process.env.DATABASE_URL. Generate schema in migrations/ using MySQL-compatible SQL. No foreign keys (PlanetScale limitation).'
      },
      {
        id: 'self-hosted-pg',
        label: 'Self-Hosted Postgres',
        freeTier: 'Your server',
        codegenHint: 'Connect to self-hosted PostgreSQL via pg driver. Use process.env.DATABASE_URL. Generate SQL migrations in migrations/. Include docker-compose.yml with postgres service if using Docker.'
      },
      {
        id: 'sqlite-local',
        label: 'SQLite (Local File)',
        freeTier: 'Unlimited',
        codegenHint: 'Use better-sqlite3 or sqlite3 npm package. Database stored in a local .db file. Generate schema in migrations/ using SQLite SQL. No external connection needed — great for standalone/self-hosted.'
      },
    ]
  },
  {
    type: 'auth',
    label: 'Authentication',
    description: 'User authentication provider',
    required: false,
    options: [
      {
        id: 'supabase-auth',
        label: 'Supabase Auth',
        freeTier: '50k MAU',
        codegenHint: 'Use Supabase Auth via @supabase/supabase-js. Auth methods: signUp, signInWithPassword, getSession. Use process.env.SUPABASE_URL and process.env.SUPABASE_ANON_KEY. Include auth middleware that verifies JWT from Supabase.'
      },
      {
        id: 'clerk',
        label: 'Clerk',
        freeTier: '10k MAU',
        codegenHint: 'Use @clerk/clerk-sdk-node. Verify sessions via Clerk session token. Use process.env.CLERK_SECRET_KEY. Include auth middleware using Clerk requireAuth.'
      },
      {
        id: 'jwt-self',
        label: 'Self-Managed JWT',
        freeTier: 'Unlimited',
        codegenHint: 'Use jsonwebtoken npm package. Generate JWT on login, verify on protected routes. Use process.env.JWT_SECRET. Include auth middleware, login/register routes, password hashing with bcrypt.'
      },
      {
        id: 'none',
        label: 'No Auth',
        freeTier: 'N/A',
        codegenHint: 'No authentication. All routes are public. Skip auth middleware.'
      },
    ]
  },
  {
    type: 'file_storage',
    label: 'File Storage',
    description: 'Where uploaded files are stored',
    required: false,
    options: [
      {
        id: 'supabase-storage',
        label: 'Supabase Storage',
        freeTier: '1GB',
        codegenHint: 'Use Supabase Storage via @supabase/supabase-js storage methods. Upload to buckets. Use process.env.SUPABASE_URL and process.env.SUPABASE_SERVICE_ROLE_KEY.'
      },
      {
        id: 'cloudflare-r2',
        label: 'Cloudflare R2',
        freeTier: '10GB',
        codegenHint: 'Use AWS S3 SDK with R2 endpoint. Use process.env.R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME. R2 is S3-compatible.'
      },
      {
        id: 'local',
        label: 'Local Filesystem',
        freeTier: 'Your server',
        codegenHint: 'Store files in a local uploads/ directory. Use fs/promises for read/write. Include static file serving for uploads/. Simple, no external service needed.'
      },
      {
        id: 'none',
        label: 'No File Storage',
        freeTier: 'N/A',
        codegenHint: 'No file upload support. Skip file storage routes.'
      },
    ]
  },
  {
    type: 'cache',
    label: 'Cache',
    description: 'Caching layer (optional)',
    required: false,
    options: [
      {
        id: 'upstash',
        label: 'Upstash Redis',
        freeTier: '10k commands/day',
        codegenHint: 'Use @upstash/redis or ioredis with Upstash REST API. Use process.env.UPSTASH_REDIS_REST_URL and process.env.UPSTASH_REDIS_REST_TOKEN. Use for session caching, rate limiting.'
      },
      {
        id: 'self-hosted-redis',
        label: 'Self-Hosted Redis',
        freeTier: 'Your server',
        codegenHint: 'Use ioredis npm package. Use process.env.REDIS_URL. Include redis service in docker-compose.yml if using Docker.'
      },
      {
        id: 'none',
        label: 'No Cache',
        freeTier: 'N/A',
        codegenHint: 'No caching layer. Skip cache integration.'
      },
    ]
  },
];

export function getComponent(type: string): InfrastructureComponent | undefined {
  return COMPONENTS.find(c => c.type === type);
}

export function getServiceOption(componentType: string, serviceId: string): ServiceOption | undefined {
  const component = getComponent(componentType);
  if (!component) return undefined;
  return component.options.find(o => o.id === serviceId);
}

// Build a combined codegen hint for all selected services
export function buildCodegenPrompt(components: Record<string, string>): string {
  const lines: string[] = [];
  for (const [type, serviceId] of Object.entries(components)) {
    const component = getComponent(type);
    const service = getServiceOption(type, serviceId);
    if (!component || !service) continue;
    lines.push(`- ${component.label}: ${service.label} (Free: ${service.freeTier})`);
    lines.push(`  ${service.codegenHint}`);
  }
  return lines.join('\n');
}

// Build env vars list for all selected services
export function buildEnvVars(components: Record<string, string>): string[] {
  const envVars: string[] = [];
  for (const [type, serviceId] of Object.entries(components)) {
    const service = getServiceOption(type, serviceId);
    if (service?.secrets) {
      envVars.push(...service.secrets);
    }
  }
  return [...new Set(envVars)];
}

// Dashboard URL for a service (for verifying deployment / viewing logs).
// projectRef is used for Supabase URLs; other platforms use their base dashboard.
export function getDashboardUrl(serviceId: string, projectRef?: string): string | undefined {
  const map: Record<string, string> = {
    'cloudflare-workers': 'https://dash.cloudflare.com',
    'vercel': 'https://vercel.com/dashboard',
    'netlify': 'https://app.netlify.com',
    'railway': 'https://railway.app/dashboard',
    'render': 'https://dashboard.render.com',
    'fly': 'https://fly.io/dashboard',
    'supabase-pg': projectRef ? `https://supabase.com/dashboard/project/${projectRef}` : 'https://supabase.com/dashboard',
    'supabase-auth': projectRef ? `https://supabase.com/dashboard/project/${projectRef}/auth/users` : 'https://supabase.com/dashboard',
    'supabase-storage': projectRef ? `https://supabase.com/dashboard/project/${projectRef}/storage` : 'https://supabase.com/dashboard',
    'neon': 'https://console.neon.tech',
    'turso': 'https://app.turso.tech',
    'planetscale': 'https://app.planetscale.com',
    'clerk': 'https://dashboard.clerk.com',
    'upstash': 'https://console.upstash.com',
    'cloudflare-r2': 'https://dash.cloudflare.com/r2',
  };
  return map[serviceId];
}

// Connection key mapping: service option ID → UserSettings.connections key.
// Cloudflare and Supabase service IDs differ from their connection keys.
const SERVICE_TO_CONN_KEY: Record<string, string> = {
  'cloudflare-workers': 'cloudflare',
  'vercel': 'vercel',
  'netlify': 'netlify',
  'railway': 'railway',
  'render': 'render',
  'fly': 'fly',
  'supabase-pg': 'supabase',
  'supabase-auth': 'supabase',
  'supabase-storage': 'supabase',
};

// Check if a service has the required credentials configured for live deploy.
// Non-live services (zip, code-level) always return true.
export function hasCredentials(serviceId: string, userConnections: any): boolean {
  const connKey = SERVICE_TO_CONN_KEY[serviceId] || serviceId;
  const c = userConnections[connKey] || {};
  switch (serviceId) {
    case 'cloudflare-workers': return !!(c.api_token && c.account_id);
    case 'vercel': return !!c.token;
    case 'netlify': return !!c.token;
    case 'railway': return !!c.token;
    case 'render': return !!c.api_key;
    case 'fly': return !!c.api_token;
    case 'supabase-pg': return !!(c.access_token && c.project_ref);
    default: return true;
  }
}

// Validate that all live-deploy components in the selection have credentials.
// Returns the list of missing components so the caller can fail fast or warn.
export function validateDeployCredentials(
  components: Record<string, string>,
  userConnections: any
): { valid: boolean; missing: { type: string; serviceId: string; label: string }[] } {
  const missing: { type: string; serviceId: string; label: string }[] = [];
  for (const [type, serviceId] of Object.entries(components)) {
    if (serviceId === 'none') continue;
    const service = getServiceOption(type, serviceId);
    if (!service) continue;
    if (service.deployType === 'live' && !hasCredentials(serviceId, userConnections)) {
      missing.push({ type, serviceId, label: service.label });
    }
  }
  return { valid: missing.length === 0, missing };
}

// Default component selections (best free-tier combo)
export const DEFAULT_COMPONENTS: Record<string, string> = {
  api_host: 'cloudflare-workers',
  database: 'supabase-pg',
  auth: 'supabase-auth',
  file_storage: 'supabase-storage',
  cache: 'none',
};