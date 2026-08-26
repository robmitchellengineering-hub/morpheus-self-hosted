import { Activity } from 'lucide-react';
import { MORPHEUS_CAPABILITIES } from '@/lib/morpheusCapabilities';
import { useGithubConnection } from '@/hooks/useGithubConnection';
import { PLATFORMS } from '@/components/matrix/ConnectionsSection';

// Live status of every Morpheus capability. Platform features are always
// READY; connection-backed ones (GitHub, live deploy) flip to CONNECTED once
// the relevant account is linked, or show SETUP NEEDED in amber so the
// operator can see at a glance what's wired up and what isn't.
export default function CapabilityStatus({ connections }) {
  const { connected: githubConnected, loading: githubLoading } = useGithubConnection();

  const hostingIds = PLATFORMS
    .filter(p => p.category === 'API Hosting' || p.id === 'supabase')
    .map(p => p.id);
  const hasHosting = hostingIds.some(
    id => connections[id] && Object.values(connections[id]).some(v => v && String(v).trim())
  );

  const statusFor = (title) => {
    if (/github/i.test(title)) return githubLoading ? 'checking' : (githubConnected ? 'connected' : 'setup');
    if (/live deploy/i.test(title)) return hasHosting ? 'connected' : 'setup';
    return 'active';
  };

  const dotClass = (status) =>
    status === 'active' || status === 'connected'
      ? 'bg-[#00ff41] shadow-[0_0_6px_#00ff41]'
      : status === 'checking'
        ? 'bg-yellow-500/70 animate-pulse'
        : 'bg-yellow-500/40';

  const labelFor = (status) =>
    status === 'active' ? 'READY'
    : status === 'connected' ? 'CONNECTED'
    : status === 'checking' ? 'CHECKING'
    : 'SETUP NEEDED';

  const labelClass = (status) =>
    status === 'setup' ? 'text-yellow-500/70' : 'text-[#00ff41]/60';

  return (
    <section className="mb-8 border border-[#00ff41]/30 p-5">
      <h2 className="text-sm font-display tracking-wider mb-1 text-[#00ff41] flex items-center gap-2">
        <Activity size={14} /> CAPABILITIES
      </h2>
      <p className="text-xs text-[#00ff41]/50 mb-4">
        // Live status of every Morpheus capability. Green = ready, amber = needs a connection to activate.
      </p>
      <div className="grid grid-cols-1 gap-0">
        {MORPHEUS_CAPABILITIES.map(c => {
          const status = statusFor(c.title);
          return (
            <div key={c.title} className="flex items-center gap-2.5 py-1.5 border-b border-[#00ff41]/10 last:border-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass(status)}`} />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-[#00ff41] truncate">{c.title}</div>
              </div>
              <span className={`text-[10px] tracking-wider shrink-0 font-display ${labelClass(status)}`}>
                {labelFor(status)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}