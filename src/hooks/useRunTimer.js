import { useState, useEffect } from 'react';

// Formats a duration in seconds as MM:SS (clamped at 0).
function formatRunTime(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Tracks elapsed run time and computes a realistic ETA for long-running actions
// (compiles, deploys, autonomous builds). Shows the same timer + stop pattern
// across every long-running surface.
//
//   running         — whether the action is currently running (drives the tick)
//   startTimeRef    — a ref set to Date.now() when the run started
//   progress        — optional { completed, total } for a DYNAMIC eta derived
//                     from actual step progress (preferred when available)
//   estimateSeconds — optional static total-time estimate (fallback before any
//                     progress data arrives)
//   etaSeconds      — optional precomputed remaining seconds (highest priority;
//                     lets a caller supply its own phase-based countdown)
export function useRunTimer({ running, startTimeRef, progress, estimateSeconds, etaSeconds }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    // Seed immediately so a re-run doesn't flash a stale elapsed value.
    setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  let computedEta = null;
  if (etaSeconds != null) {
    computedEta = Math.max(0, Math.floor(etaSeconds));
  } else if (progress && progress.total > 0 && progress.completed > 0 && progress.completed < progress.total) {
    // Dynamic: average time per completed step × remaining steps.
    computedEta = Math.round((elapsed / progress.completed) * (progress.total - progress.completed));
  } else if (estimateSeconds && estimateSeconds > 0) {
    // Static fallback: total estimate minus elapsed so far.
    computedEta = Math.max(0, estimateSeconds - elapsed);
  }

  return {
    elapsed,
    timerStr: formatRunTime(elapsed),
    etaSeconds: computedEta,
    etaStr: computedEta != null ? formatRunTime(computedEta) : null,
  };
}

export { formatRunTime };