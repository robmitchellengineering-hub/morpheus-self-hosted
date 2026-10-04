import { useState } from 'react';
import { RefreshCw } from 'lucide-react';

// Compile-time build timestamp injected by Vite (see vite.config.js `define`).
// Shown inline in the ProjectBar so the operator can confirm the construct
// page is running the latest bundle — not a stale cached one — and force a
// cache-busting hard refresh when needed.
function getBuildTime() {
  try {
    // eslint-disable-next-line no-undef
    if (typeof __APP_BUILD_TIME__ !== 'undefined') {
      // eslint-disable-next-line no-undef
      return __APP_BUILD_TIME__;
    }
  } catch (_) { /* ignore */ }
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

export default function CacheRefreshStamp() {
  const buildTime = getBuildTime();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    setRefreshing(true);
    const url = new URL(window.location.href);
    url.searchParams.set('_bust', Date.now().toString());
    window.location.href = url.toString();
  };

  return (
    <button
      onClick={handleRefresh}
      disabled={refreshing}
      className="flex items-center gap-1.5 text-[10px] text-primary/50 hover:text-primary border border-primary/20 hover:border-primary/50 px-1.5 py-0.5 transition-colors disabled:opacity-50 shrink-0"
      title={`Built ${new Date(buildTime).toLocaleString()} — click to hard refresh (cache-bust)`}
    >
      <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
      <span className="w-1 h-1 rounded-full bg-primary animate-pulse" />
      {formatAgo(buildTime)}
    </button>
  );
}