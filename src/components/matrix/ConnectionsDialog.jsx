import { useState, useEffect } from 'react';
import { X, Github, Check, XCircle, Save, Plug, ExternalLink, Zap, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useGithubConnection } from '@/hooks/useGithubConnection';
import ConnectionsSection, { PLATFORMS } from './ConnectionsSection';
import CapabilityStatus from './CapabilityStatus';
import GithubConnectionSection from './GithubConnectionSection';
import GoogleDriveConnectionSection from './GoogleDriveConnectionSection';

// Platforms grouped by the capability they unlock. A platform counts as
// "connected" when at least one of its credential fields is filled (same rule
// as ConnectionsSection). GitHub is special — it uses OAuth, not credentials.
const HOSTING_IDS = ['cloudflare', 'vercel', 'netlify', 'railway', 'render', 'fly', 'custom'];
const DB_IDS = ['supabase', 'neon', 'turso', 'planetscale'];

// The end-to-end capability matrix. `requires` references a capability key
// resolved against the live connection state. Blocked capabilities render
// their `instructions` + `links` so the user knows exactly what to connect.
const CAPABILITIES = [
  {
    id: 'frontend',
    label: 'Build frontend apps',
    description: 'Chat-driven frontend construction with live preview.',
    requires: [],
    instructions: 'Always available — powered by the platform AI. No setup needed.',
    links: [],
  },
  {
    id: 'compile',
    label: 'Compile to native binaries (APK, .exe, .app, distros)',
    description: 'GitHub Actions builds real downloadable artifacts and publishes a Release.',
    requires: ['github'],
    instructions: 'Connect your GitHub account (OAuth). Morpheus pushes code, triggers a build, and publishes the artifact as a GitHub Release.',
    links: [{ label: 'Connect GitHub', action: 'github' }],
  },
  {
    id: 'import',
    label: 'Import from GitHub',
    description: 'Pull an existing repo into Morpheus to iterate on.',
    requires: ['github'],
    instructions: 'Connect GitHub, then use IMPORT FROM GITHUB on the Construct page.',
    links: [{ label: 'Connect GitHub', action: 'github' }],
  },
  {
    id: 'export-gh',
    label: 'Export / push to GitHub',
    description: 'Push your project to a new GitHub repo.',
    requires: ['github'],
    instructions: 'Connect GitHub, then use SHARE → Push to GitHub inside a project.',
    links: [{ label: 'Connect GitHub', action: 'github' }],
  },
  {
    id: 'deploy',
    label: 'Deploy backend live',
    description: 'Auto-generate backend code and deploy to a hosting platform with log pulling.',
    requires: ['hosting'],
    instructions: 'Connect a hosting platform. Cloudflare Workers + Vercel give live deploy with log pulling; Railway / Render / Fly.io deploy via GitHub Actions.',
    links: [
      { label: 'Cloudflare tokens', url: 'https://dash.cloudflare.com/profile/api-tokens' },
      { label: 'Vercel tokens', url: 'https://vercel.com/account/tokens' },
      { label: 'Railway tokens', url: 'https://railway.app/account/tokens' },
    ],
  },
  {
    id: 'database',
    label: 'Database-backed backend',
    description: 'Postgres / MySQL / SQLite for the generated API + data layer.',
    requires: ['database'],
    instructions: 'Connect a database. Supabase gives Postgres + Auth + Storage in one. Neon is serverless Postgres (free 0.5GB). Turso is SQLite on the edge (free 9GB).',
    links: [
      { label: 'Supabase tokens', url: 'https://supabase.com/dashboard/account/tokens' },
      { label: 'Neon', url: 'https://console.neon.tech' },
      { label: 'Turso', url: 'https://app.turso.tech' },
    ],
  },
  {
    id: 'auth',
    label: 'Auth in generated backend',
    description: 'Managed authentication for your API.',
    requires: ['auth'],
    instructions: 'Connect Supabase (built-in auth) or Clerk (managed auth, 10k free MAU).',
    links: [
      { label: 'Supabase', url: 'https://supabase.com/dashboard/account/tokens' },
      { label: 'Clerk', url: 'https://dashboard.clerk.com' },
    ],
  },
  {
    id: 'storage',
    label: 'File storage in backend',
    description: 'Object storage for uploads / files.',
    requires: ['storage'],
    instructions: 'Connect Cloudflare R2 (S3-compatible, 10GB free) or Supabase Storage.',
    links: [
      { label: 'Cloudflare R2', url: 'https://dash.cloudflare.com/r2' },
      { label: 'Supabase', url: 'https://supabase.com/dashboard/account/tokens' },
    ],
  },
  {
    id: 'cache',
    label: 'Cache layer (Redis)',
    description: 'Serverless Redis for caching / queues.',
    requires: ['cache'],
    instructions: 'Connect Upstash Redis (10k cmds/day free).',
    links: [{ label: 'Upstash', url: 'https://console.upstash.com' }],
  },
  {
    id: 'marketplace',
    label: 'Sell templates (marketplace)',
    description: 'Publish paid / free templates with Stripe checkout.',
    requires: [],
    instructions: 'Always available — Stripe is connected at the platform level (live mode). Use EARN inside a project to publish.',
    links: [],
  },
];

export default function ConnectionsDialog({ open, onClose }) {
  const gh = useGithubConnection();
  const [connections, setConnections] = useState({});
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    base44.entities.UserSettings.filter({}, '-updated_date', 1)
      .then(rows => {
        if (cancelled) return;
        if (rows[0]) {
          setSettings(rows[0]);
          try { setConnections(JSON.parse(rows[0].connections || '{}')); } catch {}
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [open]);

  const isConnected = (id) => {
    if (id === 'github') return gh.connected;
    const c = connections[id];
    return !!(c && Object.values(c).some(v => v && String(v).trim()));
  };

  const ready = {
    github: gh.connected,
    hosting: HOSTING_IDS.some(isConnected),
    database: DB_IDS.some(isConnected),
    auth: isConnected('supabase') || isConnected('clerk'),
    storage: isConnected('cloudflare_r2') || isConnected('supabase'),
    cache: isConnected('upstash'),
  };

  const connectedCount = (gh.connected ? 1 : 0) + PLATFORMS.filter(p => isConnected(p.id)).length;
  const totalCount = 1 + PLATFORMS.length;

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = { connections: JSON.stringify(connections) };
      if (settings?.id) {
        await base44.entities.UserSettings.update(settings.id, payload);
      } else {
        const created = await base44.entities.UserSettings.create(payload);
        setSettings(created);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col border border-primary/40 bg-background shadow-[0_0_20px_rgba(0,255,65,0.2)]">
        {/* header */}
        <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Plug size={16} className="text-primary shrink-0" />
            <span className="text-primary font-display tracking-wider neon-glow">CONNECTIONS</span>
            <span className="text-xs text-ink/60 ml-1 truncate">{connectedCount}/{totalCount} connected</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary shrink-0"><X size={18} /></button>
        </div>

        {/* body */}
        <div className="overflow-y-auto scrollbar-matrix p-4 space-y-5">
          {/* GitHub (OAuth) — shared with Settings.jsx, see GithubConnectionSection.jsx */}
          <GithubConnectionSection />

          {/* Google Drive (OAuth) — account-level connect; per-project opt-in
              lives in ShareDialog.jsx's DRIVE tab. Feature Backlog #12. */}
          <GoogleDriveConnectionSection />

          {/* Hosting / infra platforms (reuses the Settings connections UI) */}
          {loading ? (
            <div className="flex items-center gap-2 text-ink/60 text-sm py-6 justify-center"><Loader2 size={14} className="animate-spin" /> Loading connections...</div>
          ) : (
            <ConnectionsSection connections={connections} onChange={setConnections} />
          )}

          {/* Capability matrix */}
          <section className="border border-primary/30 p-4">
            <h2 className="text-sm font-display tracking-wider mb-1 text-primary flex items-center gap-2"><Zap size={14} /> MORPHEUS CAPABILITY</h2>
            <p className="text-xs text-ink/50 mb-3">// What Morpheus can do end-to-end right now, given your connections. Blocked items show exactly what to connect.</p>
            <div className="space-y-2">
              {CAPABILITIES.map(cap => {
                const isReady = cap.requires.every(r => ready[r]);
                return (
                  <div key={cap.id} className={`border p-3 ${isReady ? 'border-primary/40 bg-primary/5' : 'border-primary/15'}`}>
                    <div className="flex items-start gap-2">
                      {isReady ? <Check size={14} className="text-primary shrink-0 mt-0.5" /> : <XCircle size={14} className="text-primary/40 shrink-0 mt-0.5" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-sm ${isReady ? 'text-ink' : 'text-ink/70'}`}>{cap.label}</span>
                          <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 border ${isReady ? 'border-primary/40 text-primary' : 'border-primary/20 text-primary/50'}`}>
                            {isReady ? 'READY' : 'BLOCKED'}
                          </span>
                        </div>
                        <p className="text-[11px] text-ink/55 mt-0.5">{cap.description}</p>
                        {!isReady && (
                          <div className="mt-2 text-[11px] text-ink/65 space-y-1.5">
                            <p>// {cap.instructions}</p>
                            {cap.links.length > 0 && (
                              <div className="flex flex-wrap gap-x-3 gap-y-1">
                                {cap.links.map(l => l.action === 'github' ? (
                                  <button key={l.label} onClick={gh.connect} className="inline-flex items-center gap-1 text-primary underline hover:text-[#39ff14]">
                                    <Github size={10} /> {l.label} <ExternalLink size={9} />
                                  </button>
                                ) : (
                                  <a key={l.label} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline hover:text-[#39ff14]">
                                    {l.label} <ExternalLink size={9} />
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Live capability status (same display as Settings) */}
          <CapabilityStatus connections={connections} />
          </div>

          {/* footer */}
        <div className="border-t border-primary/20 px-4 py-3 shrink-0 flex items-center justify-between gap-3">
          <p className="text-[10px] text-ink/50">// Hosting credentials save to your private settings. GitHub uses OAuth.</p>
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-4 py-2 border border-primary text-primary hover:bg-primary hover:text-black transition-colors text-xs font-bold disabled:opacity-40 min-h-[44px] shrink-0">
            {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
            {saving ? 'SAVING' : saved ? 'SAVED' : 'SAVE CONNECTIONS'}
          </button>
        </div>
      </div>
    </div>
  );
}