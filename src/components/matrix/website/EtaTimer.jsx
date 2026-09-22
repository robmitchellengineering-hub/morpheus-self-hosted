// A live elapsed clock + ETA for an AI action that takes minutes.
//
// Why: a plain functions.invoke returns nothing until the whole thing is done,
// so the UI had nothing to show but a spinner — reported 2026-09-22 as "it just
// sits there spinning for ages, looks like it's frozen". A ticking clock is the
// cheapest honest signal that work is still happening; the ETA comes from
// measurements (completed slices, or this button's own previous run), never from
// a hardcoded guess. When there is nothing to measure yet it says "estimating…"
// rather than inventing a number, and when the estimate is exceeded it admits
// that instead of counting into the negative.
//
// The caller owns the state (startedAt, estimateMs, done/total). This only
// renders it, so the same component serves a sliced batch and a single call.
import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function EtaTimer({ startedAt, estimateMs = null, detail, onCancel, className = '' }) {
  const [now, setNow] = useState(() => Date.now());

  // 1s tick: the ticking is the point — it is what distinguishes "working" from
  // "frozen" without needing any server cooperation.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = Math.max(0, now - (startedAt || now));
  const hasEstimate = Number.isFinite(estimateMs) && estimateMs > 0;
  const remaining = hasEstimate ? estimateMs - elapsed : null;
  const overdue = hasEstimate && remaining <= 0;
  const pct = hasEstimate ? Math.min(100, Math.round((elapsed / estimateMs) * 100)) : null;

  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-white/60 ${className}`}>
      <Loader2 size={12} className="animate-spin text-cyan-400 shrink-0" />
      {detail && <span className="text-white/80">{detail}</span>}
      <span className="tabular-nums">{mmss(elapsed)} elapsed</span>
      {overdue ? (
        <span className="text-amber-400/90">· longer than expected, still working</span>
      ) : remaining != null ? (
        <span className="tabular-nums">· ~{mmss(remaining)} left</span>
      ) : (
        <span>· estimating…</span>
      )}
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="ml-1 inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 hover:bg-white/10"
          title="Stop after the batch in progress finishes"
        >
          <X size={10} /> Stop
        </button>
      )}
      {pct != null && (
        <span className="basis-full h-0.5 w-full overflow-hidden rounded bg-white/10" aria-hidden="true">
          <span className="block h-full bg-cyan-400/70 transition-all duration-500" style={{ width: `${pct}%` }} />
        </span>
      )}
    </div>
  );
}
