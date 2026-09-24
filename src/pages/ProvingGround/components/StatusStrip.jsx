// The Proving Ground's status strip: four read-only signals, read once on mount.
//
// Deliberately not a dashboard — no polling, no refresh button. It answers "what
// state is this thing in right now" when an operator opens the page, and then
// stops costing anything.
//
// The ink classes are the page's own convention (see the cards beside it): 11px
// captions take `text-ink-max`, 14px values take `text-ink`. Self-dev's first
// version used `text-muted-foreground` at 11px, which is real and used elsewhere
// in the repo but is NOT what this page does — and verify-prose-ink.mjs cannot see
// it, because that guard only inspects elements carrying an ink token.
import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

const LABEL = 'text-[11px] text-ink-max tracking-wider uppercase mb-1';
const VALUE = 'text-sm font-mono text-ink break-words';

export default function StatusStrip() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // `invoke` resolves with an axios-style `{ data }` wrapper, not the payload —
    // see src/api/base44Client.js. Binding the whole response makes every field
    // read as undefined, which looks exactly like a backend that returned nothing.
    base44.functions.invoke('getProvingGroundStatus', {})
      .then(({ data }) => { if (!cancelled) setStatus(data); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'request failed'); });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div className="border border-danger/30 p-3 mb-4">
        <p className={LABEL}>status</p>
        <p className="text-sm text-ink break-words">unavailable — {error}</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="border border-primary/25 bg-black/30 p-3 mb-4">
        <p className="text-[11px] text-ink-max">reading status…</p>
      </div>
    );
  }

  const stats = [
    { label: 'container memory', value: status.memory || 'unavailable' },
    {
      label: 'self-dev runs',
      value: status.runCount == null
        ? `unavailable${status.runCountReason ? ` — ${status.runCountReason}` : ''}`
        : String(status.runCount),
    },
    { label: 'release branch', value: status.branch || 'main' },
    // The server's clock at the moment it answered. Read once, like everything
    // else here, so this is the time of THIS request — not a ticking clock.
    { label: 'server utc time', value: status.utcTime || 'unavailable' },
    { label: 'workspace files', value: status.workspaceFileCount == null ? 'unavailable' : String(status.workspaceFileCount) },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      {stats.map((s) => (
        <div key={s.label} className="border border-primary/25 bg-black/30 p-3">
          <p className={LABEL}>{s.label}</p>
          <p className={VALUE}>{s.value}</p>
        </div>
      ))}
    </div>
  );
}
