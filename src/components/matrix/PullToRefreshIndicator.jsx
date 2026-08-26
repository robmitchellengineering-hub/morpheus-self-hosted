import { Loader2, RefreshCw } from 'lucide-react';

// Visual indicator for pull-to-refresh. Grows from 0 to the pull distance,
// shows a spinner while refreshing, and flips the icon once the threshold is
// reached. Themed to match the Matrix aesthetic.
export default function PullToRefreshIndicator({ pullDistance, refreshing, threshold = 70, className = '' }) {
  const height = refreshing ? threshold : pullDistance;
  if (height <= 0 && !refreshing) return null;
  const ready = pullDistance >= threshold;
  return (
    <div className={`flex items-center justify-center overflow-hidden ${className}`} style={{ height }}>
      {refreshing ? (
        <Loader2 size={22} className="animate-spin text-[#00ff41]" />
      ) : (
        <RefreshCw
          size={22}
          className={`text-[#00ff41] transition-transform duration-150 ${ready ? 'rotate-180' : ''}`}
        />
      )}
    </div>
  );
}