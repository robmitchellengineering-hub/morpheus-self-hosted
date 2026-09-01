import { useState, useEffect } from 'react';
import { BarChart3, X, Loader2, Zap, DollarSign, Cloud, Terminal } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const ACTION_LABELS = {
  chat_build: 'Chat + Build',
  chat_simple: 'Chat (simple)',
  autonomous_step: 'Autonomous Step',
  test_generation: 'Test Generation',
  github_upload: 'GitHub Push',
  github_import: 'GitHub Import',
  email_export: 'Email Export',
  voice_generation: 'Voice Synthesis',
  zip_export: 'ZIP Export'
};

export default function UsagePanel({ open, onClose }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    base44.functions.invoke('getUsageStats', {})
      .then(res => setStats(res.data))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-2xl bg-background border border-primary neon-border max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/30 shrink-0">
          <div className="flex items-center gap-2">
            <BarChart3 size={18} className="text-primary" />
            <span className="text-primary font-display tracking-wider">USAGE METER</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto scrollbar-matrix p-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-primary/60" />
            </div>
          )}

          {!loading && stats && (
            <>
              <div className="border border-primary/30 p-4 mb-4">
                <div className="text-xs text-primary/50 uppercase tracking-wider mb-1">Estimated Compute Cost</div>
                <div className="text-3xl text-primary font-display flex items-center gap-2 neon-glow">
                  <DollarSign size={24} />{(stats.totalUsd || 0).toFixed(4)}
                </div>
                <div className="flex items-center gap-4 mt-3 text-xs">
                  <div className="flex items-center gap-1.5 text-primary/60">
                    <Cloud size={12} /> Platform: <span className="text-primary/80">${(stats.platformUsd || 0).toFixed(4)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-primary/60">
                    <Terminal size={12} /> Custom: <span className="text-primary/80">${(stats.customUsd || 0).toFixed(4)}</span>
                  </div>
                </div>
                <p className="text-[10px] text-primary/65 mt-2">// Estimated underlying API cost. Platform path billed via Base44 credits ({stats.totalCredits || 0} used). Custom path billed directly by your AI provider.</p>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-6">
                <div className="border border-primary/30 p-4">
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-1">Total Credits</div>
                  <div className="text-2xl text-primary font-display flex items-center gap-2">
                    <Zap size={20} /> {stats.totalCredits || 0}
                  </div>
                </div>
                <div className="border border-primary/30 p-4">
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-1">Total Actions</div>
                  <div className="text-2xl text-primary font-display">{stats.totalActions || 0}</div>
                </div>
              </div>

              <div className="text-xs text-primary/50 uppercase tracking-wider mb-2">By Operation</div>
              <div className="space-y-2 mb-6">
                {Object.entries(stats.byType || {})
                  .sort(([,a], [,b]) => b.credits - a.credits)
                  .map(([type, data]) => (
                    <div key={type} className="flex items-center justify-between border border-primary/20 px-3 py-2">
                      <div>
                        <div className="text-sm text-primary">{ACTION_LABELS[type] || type}</div>
                        <div className="text-xs text-primary/75">{data.count} action(s)</div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-primary/60 font-mono text-xs">${(data.usd || 0).toFixed(4)}</div>
                        <div className="text-primary font-display flex items-center gap-1">
                          <Zap size={14} /> {data.credits}
                        </div>
                      </div>
                    </div>
                  ))}
                {Object.keys(stats.byType || {}).length === 0 && (
                  <p className="text-primary/75 italic text-sm">// No usage recorded yet. Start building.</p>
                )}
              </div>

              {stats.recent?.length > 0 && (
                <>
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-2">Recent Activity</div>
                  <div className="space-y-1">
                    {stats.recent.map((r, i) => (
                      <div key={i} className="flex items-center justify-between text-xs border-b border-primary/10 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-primary/60">{ACTION_LABELS[r.action_type] || r.action_type}</span>
                          {r.project_name && <span className="text-primary/65 truncate">// {r.project_name}</span>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-primary/75">{new Date(r.created_date).toLocaleDateString()}</span>
                          <span className="text-primary/60 font-mono text-[10px]">${(r.usd || 0).toFixed(4)}</span>
                          <span className="text-primary flex items-center gap-0.5"><Zap size={10} />{r.credits}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {!loading && !stats && (
            <p className="text-primary/75 italic text-sm text-center py-8">// Failed to load usage data.</p>
          )}
        </div>
      </div>
    </div>
  );
}