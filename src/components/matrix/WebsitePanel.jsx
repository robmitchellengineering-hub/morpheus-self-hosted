import { useState, useEffect, useCallback } from 'react';
import { X, Globe, Loader2, Wrench, Rocket, ShoppingBag, Code, FileCode, FileText, TrendingUp, Activity, Send } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import SetupTab from './website/SetupTab';
import CodeTab from './website/CodeTab';
import DeployTab from './website/DeployTab';
import ShopTab from './website/ShopTab';
import PagesTab from './website/PagesTab';
import SeoTab from './website/SeoTab';
import TrafficTab from './website/TrafficTab';
import EmbedTab from './website/EmbedTab';
import HealthTab from './website/HealthTab';
import { TaskRunner } from './TaskRunner';

// WEBSITE panel (2026-09-10) — one place to control the Morpheus plugin on
// your own WordPress site: install + connect it (Setup), ship code changes
// (Deploy), run your shop (Shop), manage content (Pages) and own your search
// presence (SEO — added 2026-09-20). One connection per project (construct),
// private to your account. Replaces the separate STORE and DEPLOY panels.

const TABS = [
  { id: 'setup', label: 'SETUP', icon: Wrench },
  { id: 'code', label: 'CODE', icon: FileCode },
  { id: 'deploy', label: 'DEPLOY', icon: Rocket },
  // HEALTH sits with DEPLOY rather than at the end: both are "operate this
  // site", and the tab most people open most often should not be the one that
  // wraps onto a third line on a phone.
  { id: 'health', label: 'HEALTH', icon: Activity },
  { id: 'shop', label: 'SHOP', icon: ShoppingBag },
  { id: 'pages', label: 'PAGES', icon: FileText },
  { id: 'seo', label: 'SEO', icon: TrendingUp },
  // TRAFFIC sits beside SEO: both are "be found", and the tab that submits URLs
  // to an index belongs next to the one that writes what gets indexed.
  { id: 'traffic', label: 'TRAFFIC', icon: Send },
  { id: 'embed', label: 'EMBED', icon: Code },
];

export default function WebsitePanel({ open, onClose, projectId, onConnectedChange }) {
  const [store, setStore] = useState(null); // getWordPressStore result | null
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('setup');

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true); setErr(null);
    try {
      const { data } = await base44.functions.invoke('getWordPressStore', { projectId });
      setStore(data);
      onConnectedChange?.(!!data?.connected);
      return data;
    } catch (e) {
      setErr(e?.data?.error || e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId, onConnectedChange]);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    (async () => {
      const data = await load();
      setTab(data?.connected ? 'shop' : 'setup');
    })();
  }, [open, load]);

  if (!open) return null;

  const connected = store?.connected;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div className="bg-background border-l border-primary/40 w-full max-w-md h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">YOUR WEBSITE</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary p-1"><X size={18} /></button>
        </div>

        {/* Scrollable, not squeezed: seven tabs do not fit a phone screen at
            a readable size, and a clipped final tab is a dead end. */}
        {/* WRAPS rather than scrolls. Seven tabs do not fit a phone screen, and
            `overflow-x-auto` alone does not solve that: it hides the later tabs
            (PAGES, SEO, EMBED) off the right edge with no visible clue they are
            there, so on a phone the panel reads as having four tabs. A tab you
            cannot see is a tab you do not have. `shrink-0` each button and let
            the row wrap to a second line instead. */}
        {/* The runner sits ABOVE the tab switch, so a loop started in one tab is
            not unmounted by leaving it — and the strip it renders is chrome, so
            the progress is on screen from every tab. The guard checks this mount
            site rather than trusting the comment. */}
        <TaskRunner>
        <div className="flex flex-wrap border-b border-primary/15 shrink-0 text-[11px]">
          {TABS.map((t) => {
            const Icon = t.icon;
            // TRAFFIC belongs in this list: it is served by the plugin, so on a
            // project with no site connected the button could only render
            // "Connect your site in the Setup tab first." It was missing until
            // 2026-10-08, so it looked usable and then refused — the one tab
            // whose greyed state disagreed with its siblings.
            const gated = ['deploy', 'health', 'shop', 'pages', 'seo', 'traffic'].includes(t.id) ? !connected : false;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`shrink-0 basis-[96px] px-3 h-[42px] flex items-center justify-center gap-1.5 ${tab === t.id ? 'text-primary border-b-2 border-primary' : gated ? 'text-primary/25' : 'text-primary/45'}`}>
                <Icon size={13} /> {t.label}
              </button>
            );
          })}
        </div>

        {err && <div className="m-4 mb-0 text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}

        <div className="flex-1 min-h-0 flex flex-col">
          {loading && <div className="p-4 flex items-center gap-2 text-ink-strong text-xs"><Loader2 size={14} className="animate-spin" /> Loading…</div>}

          {!loading && tab === 'setup' && (
            <div className="flex-1 overflow-y-auto scrollbar-matrix">
              <SetupTab store={store} projectId={projectId} onChanged={async () => { const d = await load(); if (d?.connected) setTab('shop'); }} />
            </div>
          )}

          {!loading && tab === 'code' && (
            <div className="flex-1 overflow-y-auto scrollbar-matrix">
              <CodeTab projectId={projectId} />
            </div>
          )}

          {!loading && tab === 'deploy' && (
            <div className="flex-1 overflow-y-auto scrollbar-matrix">
              {connected
                ? <DeployTab projectId={projectId} />
                : <div className="p-4 text-[12px] text-ink-strong">Connect your site in the Setup tab first.</div>}
            </div>
          )}

          {!loading && tab === 'shop' && (
            connected
              ? <ShopTab store={store} projectId={projectId} />
              : <div className="flex-1 p-4 text-[12px] text-ink-strong">Connect your site in the Setup tab first.</div>
          )}

          {!loading && tab === 'pages' && (
            connected
              ? <PagesTab projectId={projectId} store={store} />
              : <div className="flex-1 p-4 text-[12px] text-ink-strong">Connect your site in the Setup tab first.</div>
          )}

          {!loading && tab === 'seo' && (
            connected
              ? <SeoTab projectId={projectId} store={store} />
              : <div className="flex-1 p-4 text-[12px] text-ink-strong">Connect your site in the Setup tab first.</div>
          )}

          {!loading && tab === 'traffic' && (
            connected
              ? <TrafficTab projectId={projectId} />
              : <div className="flex-1 p-4 text-[12px] text-ink-strong">Connect your site in the Setup tab first.</div>
          )}

          {!loading && tab === 'health' && (
            connected
              ? <div className="flex-1 overflow-y-auto scrollbar-matrix"><HealthTab projectId={projectId} /></div>
              : <div className="flex-1 p-4 text-[12px] text-ink-strong">Connect your site in the Setup tab first.</div>
          )}

          {!loading && tab === 'embed' && (
            <div className="flex-1 overflow-y-auto scrollbar-matrix">
              <EmbedTab projectId={projectId} connected={connected} />
            </div>
          )}
        </div>
        </TaskRunner>
      </div>
    </div>
  );
}
