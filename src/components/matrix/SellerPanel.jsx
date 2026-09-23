import { useState, useEffect } from 'react';
import { DollarSign, X, Loader2, TrendingUp, Package, RotateCcw } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function SellerPanel({ open, onClose }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    base44.functions.invoke('getSellerStats', {})
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
            <DollarSign size={18} className="text-primary" />
            <span className="text-primary font-display tracking-wider">SELLER EARNINGS</span>
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
              <div className="grid grid-cols-2 gap-3 mb-6">
                <div className="border border-primary/30 p-4">
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-1">Net Earnings</div>
                  <div className="text-2xl text-primary font-display flex items-center gap-1">
                    <DollarSign size={20} /> {(stats.totalSellerCut || 0).toFixed(2)}
                  </div>
                </div>
                <div className="border border-primary/30 p-4">
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-1">Gross Sales</div>
                  <div className="text-2xl text-primary font-display flex items-center gap-1">
                    <DollarSign size={20} /> {(stats.totalRevenue || 0).toFixed(2)}
                  </div>
                </div>
                <div className="border border-primary/30 p-4">
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-1">Platform Cut (20%)</div>
                  <div className="text-lg text-primary/70 font-display flex items-center gap-1">
                    <DollarSign size={16} /> {(stats.totalPlatformCut || 0).toFixed(2)}
                  </div>
                </div>
                <div className="border border-primary/30 p-4">
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-1">Total Sales</div>
                  <div className="text-lg text-ink font-display flex items-center gap-2">
                    <TrendingUp size={16} /> {stats.totalSales || 0}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4 text-xs text-ink/50 mb-6">
                <span className="flex items-center gap-1"><Package size={12} /> {stats.templateCount || 0} templates</span>
                <span className="flex items-center gap-1"><RotateCcw size={12} /> {stats.refunds || 0} refunds</span>
              </div>

              {Object.entries(stats.perTemplate || {}).length > 0 && (
                <>
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-2">Per Template</div>
                  <div className="space-y-2 mb-6">
                    {Object.entries(stats.perTemplate).map(([id, t]) => (
                      <div key={id} className="border border-primary/20 px-3 py-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-ink truncate">{t.name}</span>
                          <span className="text-xs text-primary/75 shrink-0 ml-2">${(t.price || 0).toFixed(2)}</span>
                        </div>
                        <div className="flex items-center justify-between mt-1 text-xs">
                          <span className="text-ink/50">{t.sales} sale(s) · {t.installs} install(s)</span>
                          <span className="text-primary font-display">+${(t.sellerCut || 0).toFixed(2)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {stats.recentSales?.length > 0 && (
                <>
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-2">Recent Sales</div>
                  <div className="space-y-1">
                    {stats.recentSales.map((s, i) => (
                      <div key={i} className="flex items-center justify-between text-xs border-b border-primary/10 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-ink/60 truncate">{s.template_name}</span>
                          {s.status === 'refunded' && <span className="text-red-500/70 shrink-0">[refunded]</span>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-ink/75">{new Date(s.created_date).toLocaleDateString()}</span>
                          <span className={s.status === 'refunded' ? 'text-red-500/60' : 'text-ink'}>
                            {s.status === 'refunded' ? '-' : '+'}${(s.seller_cut || 0).toFixed(2)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {stats.templateCount === 0 && (
                <p className="text-ink/75 italic text-sm text-center py-8">// No templates published yet. Publish from the MARKET panel to start earning.</p>
              )}
            </>
          )}

          {!loading && !stats && (
            <p className="text-ink/75 italic text-sm text-center py-8">// Failed to load earnings data.</p>
          )}
        </div>
      </div>
    </div>
  );
}