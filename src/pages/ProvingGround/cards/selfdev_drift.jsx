import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

export default function SelfdevDrift() {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    base44.functions.invoke('getSelfDevDrift', {})
      .then(({ data }) => {
        if (!alive) return;
        if (data.available === false) {
          setState({ status: 'unavailable', reason: data.reason });
          return;
        }
        setState({ status: 'ok', driftCount: data.driftCount, verdict: data.verdict });
      })
      .catch((err) => {
        if (alive) setState({ status: 'error', message: err.message });
      });
    return () => { alive = false; };
  }, []);

  return (
    <div className="space-y-2">
      {state.status === 'loading' && (
        <p className="text-xs text-ink-strong">Reading workspace drift…</p>
      )}

      {state.status === 'error' && (
        <p className="text-xs text-ink-strong">Failed to read drift: {state.message}</p>
      )}

      {state.status === 'unavailable' && (
        <p className="text-xs text-ink-strong">{state.reason}</p>
      )}

      {state.status === 'ok' && (
        <>
          <p className="text-xs font-mono text-ink-strong font-bold">
            {state.driftCount} file{state.driftCount === 1 ? '' : 's'} differ locally
          </p>
          <p className="text-[11px] font-mono text-ink-max">{state.verdict}</p>
        </>
      )}
    </div>
  );
}
