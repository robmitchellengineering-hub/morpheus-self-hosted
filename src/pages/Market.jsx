import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Search, Store, ArrowLeft, Loader2 } from 'lucide-react';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import PullToRefreshIndicator from '@/components/matrix/PullToRefreshIndicator';
import MarketTrustStrip from '@/components/matrix/MarketTrustStrip';
import MarketHowItWorks from '@/components/matrix/MarketHowItWorks';
import MarketFooter from '@/components/matrix/MarketFooter';
import VerifiedBadge from '@/components/matrix/VerifiedBadge';
import ShareButton from '@/components/matrix/ShareButton';

export default function Market() {
  const [templates, setTemplates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await base44.functions.invoke('browseTemplates', { category, q: query });
      setTemplates(res.data?.templates || []);
      setCategories(res.data?.categories || []);
    } catch {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, [category, query]);

  useEffect(() => { load(); }, [load]);

  // Silent refresh for pull-to-refresh — re-fetches without toggling the
  // full-screen loading spinner so the grid stays visible during the gesture.
  const refresh = useCallback(async () => {
    try {
      const res = await base44.functions.invoke('browseTemplates', { category, q: query });
      setTemplates(res.data?.templates || []);
      setCategories(res.data?.categories || []);
    } catch {
      setTemplates([]);
    }
  }, [category, query]);

  const listRef = useRef(null);
  const { pullDistance, refreshing } = usePullToRefresh({ onRefresh: refresh, containerRef: listRef });

  const fmtPrice = (p) => (p && p > 0 ? `$${Number(p).toFixed(2)}` : 'FREE');

  return (
    <div ref={listRef} className="min-h-screen bg-black text-[#00ff41]">
      <PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} />
      {/* Header */}
      <header className="border-b border-[#00ff41]/20 sticky top-0 z-10 bg-black/95 backdrop-blur-sm safe-top">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <Store size={18} className="text-[#00ff41] shrink-0" />
            <span className="font-display tracking-wider text-sm md:text-base neon-glow truncate">MORPHEUS MARKET</span>
          </div>
          <Link to="/" className="text-xs text-[#00ff41]/60 hover:text-[#00ff41] flex items-center gap-1 shrink-0">
            <ArrowLeft size={12} /> APP
          </Link>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-4">
        {/* Search */}
        <div className="flex items-center gap-2 border border-[#00ff41]/30 px-3 py-2.5 mb-4">
          <Search size={16} className="text-[#00ff41]/50 shrink-0" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search constructs..."
            className="bg-transparent text-[#00ff41] text-sm outline-none w-full"
          />
        </div>

        {/* Category pills */}
        {categories.length > 0 && (
          <div className="flex gap-2 overflow-x-auto scrollbar-matrix pb-2 mb-4 overscroll-none">
            <button
              onClick={() => setCategory('all')}
              className={`text-xs px-3 py-1.5 border whitespace-nowrap transition-colors ${category === 'all' ? 'border-[#00ff41] bg-[#00ff41]/10 text-[#00ff41]' : 'border-[#00ff41]/20 text-[#00ff41]/50 hover:text-[#00ff41]'}`}
            >
              ALL
            </button>
            {categories.map(c => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`text-xs px-3 py-1.5 border whitespace-nowrap transition-colors ${category === c ? 'border-[#00ff41] bg-[#00ff41]/10 text-[#00ff41]' : 'border-[#00ff41]/20 text-[#00ff41]/50 hover:text-[#00ff41]'}`}
              >
                {c.toUpperCase()}
              </button>
            ))}
          </div>
        )}

        {/* Trust signals */}
        <MarketTrustStrip />

        {/* How it works */}
        <MarketHowItWorks />

        {/* Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="animate-spin text-[#00ff41]/50" size={24} />
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-20 text-[#00ff41]/75">
            <Store size={32} className="mx-auto mb-3 opacity-50" />
            <p className="text-sm">No constructs found. Be the first to publish.</p>
            <Link to="/workspace" className="inline-block mt-4 text-xs text-[#00ff41] border border-[#00ff41]/30 hover:border-[#00ff41]/60 px-4 py-2">
              OPEN BUILDER →
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {templates.map(t => (
              <Link
                key={t.id}
                to={`/store/${t.id}`}
                className="border border-[#00ff41]/20 hover:border-[#00ff41]/60 bg-[#00ff41]/5 hover:bg-[#00ff41]/10 transition-all p-3 flex flex-col gap-2 group"
              >
                <div className="aspect-square border border-[#00ff41]/10 bg-black flex items-center justify-center overflow-hidden">
                  {t.icon ? (
                    <img src={t.icon} alt={t.name} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-3xl font-display text-[#00ff41]/65 group-hover:text-[#00ff41]/50 transition-colors">
                      {t.name?.charAt(0)?.toUpperCase() || '?'}
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-[#00ff41] text-sm font-bold truncate">{t.name}</div>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[#00ff41]/75 text-xs truncate">by {t.author_name}</span>
                    <VerifiedBadge />
                  </div>
                </div>
                <div className="flex items-center justify-between mt-auto pt-1">
                  <span className="text-[10px] text-[#00ff41]/50 uppercase truncate">{t.compile_target?.replace('-', ' ')}</span>
                  <span className={`text-xs font-bold ${t.price > 0 ? 'text-[#00ff41]' : 'text-[#00ff41]/50'}`}>
                    {fmtPrice(t.price)}
                  </span>
                </div>
                <ShareButton templateId={t.id} className="self-end mt-1" />
              </Link>
            ))}
          </div>
        )}
      </div>
      <MarketFooter />
    </div>
  );
}