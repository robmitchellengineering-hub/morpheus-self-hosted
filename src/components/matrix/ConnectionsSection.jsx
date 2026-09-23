import { useState } from 'react';
import { Cloud, Database, Rocket, Globe, Server, Plane, Terminal, Box, Key, HardDrive, Zap, ChevronDown, ChevronRight, ExternalLink, Eye, EyeOff, Check } from 'lucide-react';

export const PLATFORMS = [
  // --- API Hosting ---
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    icon: Cloud,
    category: 'API Hosting',
    description: 'Workers edge deploy — live deploy supported',
    fields: [
      { key: 'api_token', label: 'API Token', type: 'password', placeholder: 'cf-...', hint: 'My Profile → API Tokens → Edit Workers' },
      { key: 'account_id', label: 'Account ID', type: 'text', placeholder: 'abc123...', hint: 'Right sidebar of Cloudflare dashboard' }
    ],
    setupUrl: 'https://dash.cloudflare.com/profile/api-tokens'
  },
  {
    id: 'vercel',
    label: 'Vercel',
    icon: Rocket,
    category: 'API Hosting',
    description: 'Serverless functions — live deploy supported',
    fields: [
      { key: 'token', label: 'Access Token', type: 'password', placeholder: 'vercel_...' },
      { key: 'project_id', label: 'Project ID (optional)', type: 'text', placeholder: 'prj_...' },
      { key: 'deployment_id', label: 'Deployment ID (for logs)', type: 'text', placeholder: 'dpl_...' },
      { key: 'team_id', label: 'Team ID (optional)', type: 'text', placeholder: 'team_...' }
    ],
    setupUrl: 'https://vercel.com/account/tokens'
  },
  {
    id: 'netlify',
    label: 'Netlify',
    icon: Globe,
    category: 'API Hosting',
    description: 'Static sites + serverless functions — live deploy supported',
    fields: [
      { key: 'token', label: 'Auth Token', type: 'password', placeholder: 'nfp_...' },
      { key: 'site_id', label: 'Site ID (optional)', type: 'text', placeholder: 'xxx-xxx-xxx' }
    ],
    setupUrl: 'https://app.netlify.com/user/applications'
  },
  {
    id: 'railway',
    label: 'Railway',
    icon: Box,
    category: 'API Hosting',
    description: 'Full-stack app hosting — live deploy supported (GitHub-connected)',
    fields: [
      { key: 'token', label: 'API Token', type: 'password', placeholder: 'railway-...' }
    ],
    setupUrl: 'https://railway.app/account/tokens'
  },
  {
    id: 'render',
    label: 'Render',
    icon: Server,
    category: 'API Hosting',
    description: 'Web services + databases — live deploy supported (GitHub-connected)',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', placeholder: 'rnd_...' },
      { key: 'service_id', label: 'Service ID (for logs)', type: 'text', placeholder: 'srv-...' }
    ],
    setupUrl: 'https://dashboard.render.com/u/settings'
  },
  {
    id: 'fly',
    label: 'Fly.io',
    icon: Plane,
    category: 'API Hosting',
    description: 'Global app deployment — live deploy supported (GitHub Actions)',
    fields: [
      { key: 'api_token', label: 'API Token', type: 'password', placeholder: 'Fly...' }
    ],
    setupUrl: 'https://fly.io/app/personal-access-tokens'
  },
  // --- Database ---
  {
    id: 'supabase',
    label: 'Supabase',
    icon: Database,
    category: 'Database / Auth / Storage',
    description: 'Postgres + Auth + Storage — live deploy supported',
    fields: [
      { key: 'access_token', label: 'Access Token (Management API)', type: 'password', placeholder: 'sbp_...', hint: 'For deploy + logs' },
      { key: 'project_ref', label: 'Project Ref', type: 'text', placeholder: 'abc...xyz', hint: 'Settings → API → Project URL' },
      { key: 'url', label: 'Project URL (for generated code)', type: 'text', placeholder: 'https://xxx.supabase.co' },
      { key: 'anon_key', label: 'Anon Key (public)', type: 'password', placeholder: 'eyJ...' },
      { key: 'service_role_key', label: 'Service Role Key (secret)', type: 'password', placeholder: 'eyJ...' }
    ],
    setupUrl: 'https://supabase.com/dashboard/account/tokens'
  },
  {
    id: 'neon',
    label: 'Neon',
    icon: Database,
    category: 'Database / Auth / Storage',
    description: 'Serverless Postgres — free 0.5GB',
    fields: [
      { key: 'database_url', label: 'Database URL', type: 'password', placeholder: 'postgres://...' }
    ],
    setupUrl: 'https://console.neon.tech'
  },
  {
    id: 'turso',
    label: 'Turso',
    icon: Database,
    category: 'Database / Auth / Storage',
    description: 'SQLite on the edge — free 9GB',
    fields: [
      { key: 'database_url', label: 'Database URL', type: 'text', placeholder: 'libsql://...' },
      { key: 'auth_token', label: 'Auth Token', type: 'password', placeholder: 'eyJ...' }
    ],
    setupUrl: 'https://app.turso.tech'
  },
  {
    id: 'planetscale',
    label: 'PlanetScale',
    icon: Database,
    category: 'Database / Auth / Storage',
    description: 'MySQL — free 5GB',
    fields: [
      { key: 'database_url', label: 'Database URL', type: 'password', placeholder: 'mysql://...' }
    ],
    setupUrl: 'https://app.planetscale.com'
  },
  // --- Auth ---
  {
    id: 'clerk',
    label: 'Clerk',
    icon: Key,
    category: 'Auth',
    description: 'Managed auth — free 10k MAU',
    fields: [
      { key: 'secret_key', label: 'Secret Key', type: 'password', placeholder: 'sk_test_...' }
    ],
    setupUrl: 'https://dashboard.clerk.com'
  },
  // --- File Storage ---
  {
    id: 'cloudflare_r2',
    label: 'Cloudflare R2',
    icon: HardDrive,
    category: 'File Storage',
    description: 'S3-compatible object storage — free 10GB',
    fields: [
      { key: 'account_id', label: 'Account ID', type: 'text', placeholder: 'abc123...' },
      { key: 'access_key_id', label: 'Access Key ID', type: 'password', placeholder: 'R2...' },
      { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', placeholder: 'R2...' },
      { key: 'bucket_name', label: 'Bucket Name', type: 'text', placeholder: 'my-bucket' }
    ],
    setupUrl: 'https://dash.cloudflare.com/r2'
  },
  // --- Cache ---
  {
    id: 'upstash',
    label: 'Upstash Redis',
    icon: Zap,
    category: 'Cache',
    description: 'Serverless Redis — free 10k cmds/day',
    fields: [
      { key: 'rest_url', label: 'REST URL', type: 'text', placeholder: 'https://....upstash.io' },
      { key: 'rest_token', label: 'REST Token', type: 'password', placeholder: 'AX...' }
    ],
    setupUrl: 'https://console.upstash.com'
  },
  // --- Custom ---
  {
    id: 'custom',
    label: 'Custom / Self-Hosted',
    icon: Terminal,
    category: 'Other',
    description: 'Your own server, VPS, or on-prem infrastructure',
    fields: [
      { key: 'deploy_url', label: 'Deploy URL (optional)', type: 'text', placeholder: 'https://your-server.com/deploy' },
      { key: 'token', label: 'Auth Token (optional)', type: 'password', placeholder: 'Bearer token...' }
    ],
    setupUrl: ''
  },
];

export default function ConnectionsSection({ connections, onChange }) {
  const [expanded, setExpanded] = useState(null);
  const [showSecrets, setShowSecrets] = useState({});

  const toggleSecret = (key) => setShowSecrets(prev => ({ ...prev, [key]: !prev[key] }));

  const updateField = (platformId, fieldKey, value) => {
    onChange({
      ...connections,
      [platformId]: {
        ...(connections[platformId] || {}),
        [fieldKey]: value
      }
    });
  };

  return (
    <section className="mb-8 border border-primary/30 p-5">
      <h2 className="text-sm font-display tracking-wider mb-1 text-primary flex items-center gap-2">
        <Globe size={14} /> CONNECTIONS
      </h2>
      <p className="text-xs text-ink/50 mb-4">
        // Link your hosting and infrastructure accounts. Cloudflare + Supabase enable live deploy with log pulling. All credentials are used by generated backend code and deploy pipelines.
      </p>
      <div className="space-y-4">
        {Object.entries(
          PLATFORMS.reduce((acc, p) => {
            (acc[p.category] = acc[p.category] || []).push(p);
            return acc;
          }, {})
        ).map(([category, platforms]) => (
          <div key={category}>
            <div className="text-[10px] text-primary/65 uppercase tracking-widest mb-1.5 px-1">{category}</div>
            <div className="space-y-2">
              {platforms.map(p => {
                const Icon = p.icon;
                const isExpanded = expanded === p.id;
                const isConnected = connections[p.id] && Object.values(connections[p.id]).some(v => v && v.trim());
                return (
                  <div key={p.id} className={`border transition-colors ${isExpanded ? 'border-primary/50' : 'border-primary/20'}`}>
                    <button
                      onClick={() => setExpanded(isExpanded ? null : p.id)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-primary/5 transition-colors"
                    >
                      <Icon size={14} className={isConnected ? 'text-primary shrink-0' : 'text-primary/50 shrink-0'} />
                      <span className={`text-sm flex-1 ${isConnected ? 'text-primary' : 'text-primary/70'}`}>{p.label}</span>
                      {isConnected && <Check size={12} className="text-primary shrink-0" />}
                      {isExpanded ? <ChevronDown size={14} className="text-primary/75 shrink-0" /> : <ChevronRight size={14} className="text-primary/75 shrink-0" />}
                    </button>
                    {isExpanded && (
                      <div className="px-3 pb-3 pt-1 space-y-3 border-t border-primary/10">
                        <p className="text-xs text-ink/75">{p.description}</p>
                        {p.setupUrl && (
                          <a href={p.setupUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary/60 hover:text-primary underline">
                            <ExternalLink size={10} /> Get token / setup guide
                          </a>
                        )}
                        {p.fields.map(f => {
                          const secretKey = `${p.id}_${f.key}`;
                          const isSecret = f.type === 'password';
                          const showThis = showSecrets[secretKey];
                          return (
                            <div key={f.key}>
                              <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1">{f.label}</label>
                              <div className="flex gap-2">
                                <input
                                  type={isSecret && !showThis ? 'password' : 'text'}
                                  value={connections[p.id]?.[f.key] || ''}
                                  onChange={e => updateField(p.id, f.key, e.target.value)}
                                  placeholder={f.placeholder}
                                  className="flex-1 bg-background text-primary border border-primary/30 px-3 py-2 text-sm outline-none placeholder:text-primary/20"
                                />
                                {isSecret && (
                                  <button
                                    onClick={() => toggleSecret(secretKey)}
                                    className="px-3 border border-primary/30 text-primary/60 hover:text-primary"
                                    title={showThis ? 'Hide' : 'Show'}
                                  >
                                    {showThis ? <EyeOff size={16} /> : <Eye size={16} />}
                                  </button>
                                )}
                              </div>
                              {f.hint && <p className="text-[10px] text-ink/65 mt-1">{f.hint}</p>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}