import { useState, useEffect, useRef, useCallback } from 'react';
import { Globe, Loader2, Rocket, ShoppingBag, ExternalLink, MessageSquare, FileText, TrendingUp } from 'lucide-react';
import { base44, setOverrideToken } from '@/api/base44Client';
import DeployTab from '@/components/matrix/website/DeployTab';
import ShopTab from '@/components/matrix/website/ShopTab';
import PagesTab from '@/components/matrix/website/PagesTab';
import SeoTab from '@/components/matrix/website/SeoTab';
import EmbedChat from '@/components/matrix/website/EmbedChat';

// The embeddable-widget surface — loaded in an iframe by public/plugin.js on
// the owner's own site. Authenticates with the `wgt_` token in ?token=,
// which the backend pins to one project + a fixed set of scopes. Reports
// its content height to the parent so the iframe never scrolls internally.

const SCOPE_TABS = [
  { scope: 'chat', id: 'chat', label: 'CHAT', icon: MessageSquare },
  { scope: 'deploy', id: 'deploy', label: 'DEPLOY', icon: Rocket },
  { scope: 'store', id: 'shop', label: 'SHOP', icon: ShoppingBag },
  { scope: 'store', id: 'pages', label: 'PAGES', icon: FileText },
  { scope: 'seo', id: 'seo', label: 'SEO', icon: TrendingUp },
];

export default function Embed() {
  const [ctx, setCtx] = useState(null); // { projectId, projectName, scopes }
  const [store, setStore] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState(null);
  const rootRef = useRef(null);
  // The floating dock (public/plugin.js) appends the page it's open over —
  // used to ground CHAT's answers in what the operator is actually looking
  // at (see chatWithMorpheus.js's currentPageBlock). Absent for a plain
  // inline embed or when the loader predates this.
  const pageUrlRef = useRef(null);
  const pageTitleRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    pageUrlRef.current = params.get('pageUrl') || null;
    pageTitleRef.current = params.get('pageTitle') || null;
    if (!token) { setErr('This embed is missing its token.'); return; }
    setOverrideToken(token);
    (async () => {
      try {
        const { data } = await base44.functions.invoke('getWidgetContext', {});
        setCtx(data);
        const tabs = SCOPE_TABS.filter((t) => data.scopes.includes(t.scope));
        setTab(tabs[0]?.id || null);
        // The SEO surface reads the site context through getWordPressStore
        // too, so it needs the same fetch.
        if (data.scopes.includes('store') || data.scopes.includes('seo')) {
          try {
            const s = await base44.functions.invoke('getWordPressStore', {});
            setStore(s.data);
          } catch { /* store tab will show its own not-ready state */ }
        }
      } catch (e) {
        setErr(e?.data?.error || e.message);
      }
    })();
  }, []);

  // Height reporting — keep the iframe exactly as tall as the content.
  const reportHeight = useCallback(() => {
    const h = rootRef.current?.scrollHeight;
    if (h && window.parent !== window) {
      window.parent.postMessage({ type: 'morpheus:resize', height: h }, '*');
    }
  }, []);

  useEffect(() => {
    if (!rootRef.current) return;
    reportHeight();
    const ro = new ResizeObserver(reportHeight);
    ro.observe(rootRef.current);
    const t = setInterval(reportHeight, 1000); // catch late async content
    return () => { ro.disconnect(); clearInterval(t); };
  }, [reportHeight, ctx, tab, store]);

  const tabs = ctx ? SCOPE_TABS.filter((t) => ctx.scopes.includes(t.scope)) : [];
  const chatOnly = ctx && tabs.length === 0;

  return (
    <div ref={rootRef} className="min-h-[200px] bg-background text-primary font-mono">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/20">
        <Globe size={15} className="text-primary" />
        <span className="font-display tracking-wider text-[13px]">
          {ctx ? ctx.projectName : 'Morpheus'}
        </span>
      </div>

      {err && <div className="m-4 text-red-400 text-[12px] border border-red-500/30 px-3 py-2">{err}</div>}

      {!ctx && !err && (
        <div className="p-6 flex items-center gap-2 text-primary/60 text-xs"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      )}

      {ctx && chatOnly && (
        <div className="p-6 text-[12px] text-primary/60 leading-relaxed">
          This embed has no panels enabled — open it in Morpheus for the full workspace.
          <a href="https://morpheus.nz/workspace" target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary/80 hover:text-primary ml-1">open <ExternalLink size={10} /></a>
        </div>
      )}

      {ctx && tabs.length > 0 && (
        <>
          {tabs.length > 1 && (
            <div className="flex border-b border-primary/15 text-[11px]">
              {tabs.map((t) => {
                const Icon = t.icon;
                return (
                  <button key={t.id} onClick={() => setTab(t.id)}
                    className={`flex-1 h-[40px] flex items-center justify-center gap-1.5 ${tab === t.id ? 'text-primary border-b-2 border-primary' : 'text-primary/45'}`}>
                    <Icon size={13} /> {t.label}
                  </button>
                );
              })}
            </div>
          )}
          {tab === 'chat' && (
            <EmbedChat projectId={ctx.projectId} projectName={ctx.projectName} scopes={ctx.scopes}
              pageUrl={pageUrlRef.current} pageTitle={pageTitleRef.current} />
          )}
          {tab === 'deploy' && <DeployTab projectId={ctx.projectId} />}
          {tab === 'shop' && (
            store
              ? <ShopTab store={store} projectId={ctx.projectId} />
              : <div className="p-4 text-[12px] text-primary/50">The connected store isn’t reachable right now.</div>
          )}
          {tab === 'pages' && <PagesTab projectId={ctx.projectId} store={store} />}
          {tab === 'seo' && <SeoTab projectId={ctx.projectId} store={store} />}
        </>
      )}
    </div>
  );
}
