import { useState } from 'react';
import { RefreshCw, CheckCircle2 } from 'lucide-react';

// Compile-time build timestamp injected by Vite (see vite.config.js `define`).
// Updates on every dev-server restart / production build, so you can tell at a
// glance whether the preview is showing the latest bundle or a stale one.
function getBuildTime() {
  try {
    // eslint-disable-next-line no-undef
    if (typeof __APP_BUILD_TIME__ !== 'undefined') {
      // eslint-disable-next-line no-undef
      return __APP_BUILD_TIME__;
    }
  } catch (_) {}
  return new Date().toISOString();
}

function formatAgo(iso) {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function BuildStamp() {
  const buildTime = getBuildTime();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    setRefreshing(true);
    // Cache-bust by appending a unique query param, then hard reload.
    const url = new URL(window.location.href);
    url.searchParams.set('_bust', Date.now().toString());
    window.location.href = url.toString();
  };

  return (
    <div className="font-mono text-primary select-none">
      {open ? (
        <div className="flex items-center gap-2 bg-black/90 border border-primary/40 px-2 py-1 text-[10px]">
          <CheckCircle2 size={11} className="text-primary/70 shrink-0" />
          <div className="flex flex-col leading-tight">
            <span className="text-primary/80">BUILD {new Date(buildTime).toLocaleTimeString()}</span>
            <span className="text-primary/75">{formatAgo(buildTime)} · {new Date(buildTime).toLocaleDateString()}</span>
          </div>
          <button onClick={handleRefresh} disabled={refreshing} className="ml-1 text-primary hover:text-black hover:bg-primary p-1 border border-primary/40 hover:border-primary transition-colors disabled:opacity-50" title="Hard refresh (cache-bust)">
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => setOpen(false)} className="text-primary/75 hover:text-primary px-1 text-[10px]">×</button>
        </div>
      ) : (
        <button onClick={() => setOpen(true)} className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary px-2.5 py-1.5 border border-primary/30 hover:border-primary/60 hover:bg-primary/5 transition-colors shrink-0" title="Build version — click for refresh">
          <RefreshCw size={14} />
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          {formatAgo(buildTime)}
        </button>
      )}
    </div>
  );
}