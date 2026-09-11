import { useState, useEffect, useCallback } from 'react';
import { X, Globe, Loader2, Wrench, Rocket, ShoppingBag, Code, FileCode, FileText } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import SetupTab from './website/SetupTab';
import CodeTab from './website/CodeTab';
import DeployTab from './website/DeployTab';
import ShopTab from './website/ShopTab';
import PagesTab from './website/PagesTab';
import EmbedTab from './website/EmbedTab';

// WEBSITE panel (2026-09-10) — one place to control the Morpheus plugin on
// your own WordPress site: install + connect it (Setup), ship code changes
// (Deploy), and run your shop (Shop). One connection per project (construct),
// private to your account. Replaces the separate STORE and DEPLOY panels.

const TABS = [
  { id: 'setup', label: 'SETUP', icon: Wrench },
  { id: 'code', label: 'CODE', icon: FileCode },
  { id: 'deploy', label: 'DEPLOY', icon: Rocket },
  { id: 'shop', label: 'SHOP', icon: ShoppingBag },
  { id: 'pages', label: 'PAGES', icon: FileText },
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

        <div className="flex border-b border-primary/15 shrink-0 text-[11px]">
          {TABS.map((t) => {
            const Icon = t.icon;
            const gated = t.id === 'deploy' || t.id === 'shop' || t.id === 'pages' ? !connected : false;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex-1 h-[42px] flex items-center justify-center gap-1.5 ${tab === t.id ? 'text-primary border-b-2 border-primary' : gated ? 'text-primary/25' : 'text-primary/45'}`}>
                <Icon size={13} /> {t.label}
              </button>
            );
          })}
        </div>

        {err && <div className="m-4 mb-0 text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}

        <div className="flex-1 min-h-0 flex flex-col">
          {loading && <div className="p-4 flex items-center gap-2 text-primary/60 text-xs"><Loader2 size={14} className="animate-spin" /> Loading…</div>}

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
                : <div className="p-4 text-[12px] text-primary/50">Connect your site in the Setup tab first.</div>}
            </div>
          )}

          {!loading && tab === 'shop' && (
            connected
              ? <ShopTab store={store} projectId={projectId} />
              : <div className="flex-1 p-4 text-[12px] text-primary/50">Connect your site in the Setup tab first.</div>
          )}

          {!loading && tab === 'pages' && (
            connected
              ? <PagesTab projectId={projectId} />
              : <div className="flex-1 p-4 text-[12px] text-primary/50">Connect your site in the Setup tab first.</div>
          )}

          {!loading && tab === 'embed' && (
            <div className="flex-1 overflow-y-auto scrollbar-matrix">
              <EmbedTab projectId={projectId} connected={connected} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
