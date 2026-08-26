import { useState } from 'react';
import { ChevronDown, ChevronRight, Globe, ExternalLink } from 'lucide-react';

// Platform-specific DNS + env-var setup instructions for services that don't
// support automated API configuration. Shown in BackendConfigSection so the
// user can prepare DNS before deploying.

const GUIDES = {
  'render': {
    label: 'Render',
    dashboard: 'https://dashboard.render.com',
    cnameTarget: 'your-service.onrender.com',
    envSteps: [
      'Go to dashboard.render.com → your web service',
      'Click "Environment" in the left sidebar',
      'Add variable: API_KEYS = <your-key-hash-list>',
      'Save changes — Render redeploys automatically',
    ],
    domainSteps: [
      'Go to your service → Settings → Custom Domains',
      'Click "Add Custom Domain" and enter your domain',
      'In your DNS provider, add a CNAME record:',
      '  <your-subdomain> → <your-service>.onrender.com',
      'Wait for DNS propagation (5-30 min), then verify in Render',
    ],
  },
  'railway': {
    label: 'Railway',
    dashboard: 'https://railway.app/dashboard',
    cnameTarget: 'your-service.up.railway.app',
    envSteps: [
      'Go to railway.app/dashboard → your project',
      'Click the service → "Variables" tab',
      'Add variable: API_KEYS = <your-key-hash-list>',
      'Railway auto-redeploys on variable change',
    ],
    domainSteps: [
      'Go to your service → Settings → Networking',
      'Click "Generate Domain" for a free railway.app URL, OR',
      'Click "Custom Domain" and enter your domain',
      'Add a CNAME record in your DNS provider:',
      '  <your-subdomain> → <your-service>.up.railway.app',
    ],
  },
  'fly': {
    label: 'Fly.io',
    dashboard: 'https://fly.io/dashboard',
    cnameTarget: 'your-app.fly.dev',
    envSteps: [
      'Option A (CLI): flyctl secrets set API_KEYS="<your-key-hash-list>" --app <app-name>',
      'Option B (dashboard): fly.io/apps/<app> → Secrets → Add API_KEYS',
    ],
    domainSteps: [
      'Option A (CLI): flyctl certs add <your-domain> --app <app-name>',
      'Option B (dashboard): fly.io/apps/<app> → Certificates → Add certificate',
      'Add a CNAME record in your DNS provider:',
      '  <your-subdomain> → <your-app>.fly.dev',
      'Fly provisions the TLS cert automatically once DNS resolves',
    ],
  },
  'netlify': {
    label: 'Netlify',
    dashboard: 'https://app.netlify.com',
    cnameTarget: 'your-site.netlify.app',
    envSteps: [
      'Go to app.netlify.com → your site',
      'Site settings → Environment variables',
      'Add variable: API_KEYS = <your-key-hash-list>',
      'Trigger a new deploy to apply (or auto-deploy on next push)',
    ],
    domainSteps: [
      'Go to your site → Domain settings',
      'Click "Add custom domain" and enter your domain',
      'Add a CNAME record in your DNS provider:',
      '  <your-subdomain> → <your-site>.netlify.app',
      'Netlify provisions TLS automatically via Let\'s Encrypt',
    ],
  },
  'supabase-pg': {
    label: 'Supabase (Edge Functions)',
    dashboard: 'https://supabase.com/dashboard',
    cnameTarget: '<fn-id>.supabase.co',
    envSteps: [
      'Go to supabase.com/dashboard → your project → Functions',
      'Click your function → "Secrets" tab',
      'Add secret: API_KEYS = <your-key-hash-list>',
      'Redeploy the function to apply',
    ],
    domainSteps: [
      'Go to your project → Functions → your function',
      'Click "Custom Domain" and enter your domain',
      'Add a CNAME record in your DNS provider:',
      '  <your-subdomain> → <fn-id>.supabase.co',
      'Supabase provisions TLS automatically',
    ],
  },
  'self-hosted-docker': {
    label: 'Self-Hosted Docker',
    dashboard: '',
    cnameTarget: 'your-server-ip',
    envSteps: [
      'Edit your .env file on the server',
      'Add: API_KEYS=<your-key-hash-list>',
      'Run: docker-compose down && docker-compose up -d',
    ],
    domainSteps: [
      'Point an A record in your DNS provider to your server IP',
      'Configure a reverse proxy (nginx/caddy) for TLS',
      'Or use Cloudflare proxy in front of your server',
    ],
  },
  'standalone': {
    label: 'Standalone Node',
    dashboard: '',
    cnameTarget: 'your-server-ip',
    envSteps: [
      'Edit .env on your server',
      'Add: API_KEYS=<your-key-hash-list>',
      'Restart the Node process (pm2 restart / systemctl restart)',
    ],
    domainSteps: [
      'Point an A record in your DNS provider to your server IP',
      'Configure a reverse proxy (nginx/caddy) for TLS termination',
      'Ensure your Node app listens on the correct port',
    ],
  },
};

export default function DnsSetupGuide({ service }) {
  const [open, setOpen] = useState(false);
  const guide = GUIDES[service];

  if (!guide) return null;

  return (
    <div className="border border-[#00ff41]/10">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-[#00ff41]/5 transition-colors"
      >
        {open ? <ChevronDown size={12} className="text-[#00ff41]/75" /> : <ChevronRight size={12} className="text-[#00ff41]/75" />}
        <Globe size={12} className="text-[#00ff41]/75" />
        <span className="text-[10px] text-[#00ff41]/50 uppercase tracking-wider">
          DNS setup guide — {guide.label}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t border-[#00ff41]/10">
          {guide.dashboard && (
            <a href={guide.dashboard} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] text-[#00ff41]/60 hover:text-[#00ff41] underline">
              <ExternalLink size={10} /> {guide.dashboard}
            </a>
          )}

          <div>
            <div className="text-[10px] text-[#00ff41]/75 uppercase mb-1">API Key (env var)</div>
            <div className="space-y-0.5">
              {guide.envSteps.map((step, i) => (
                <div key={i} className="text-[10px] text-[#00ff41]/50 font-mono leading-relaxed">{step}</div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] text-[#00ff41]/75 uppercase mb-1">Custom Domain (DNS)</div>
            <div className="space-y-0.5">
              {guide.domainSteps.map((step, i) => (
                <div key={i} className="text-[10px] text-[#00ff41]/50 font-mono leading-relaxed">{step}</div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}