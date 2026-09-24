import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

export default function SelfdevRuns() {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    base44.functions.invoke('getSelfDevRuns', { limit: 5 })
      .then(({ data }) => {
        if (!alive) return;
        if (data.available === false) {
          setState({ status: 'unavailable', reason: data.reason });
          return;
        }
        setState({ status: 'ok', runs: data.runs || [] });
      })
      .catch((err) => {
        if (alive) setState({ status: 'error', message: err.message });
      });
    return () => { alive = false; };
  }, []);

  return (
    <div className="space-y-2">
      {state.status === 'loading' && (
        <p className="text-xs text-ink-strong">Loading runs…</p>
      )}

      {state.status === 'error' && (
        <p className="text-xs text-ink-strong">Failed to load: {state.message}</p>
      )}

      {state.status === 'unavailable' && (
        <p className="text-xs text-ink-strong">{state.reason}</p>
      )}

      {state.status === 'ok' && state.runs.length === 0 && (
        <p className="text-xs text-ink-strong">No runs have been recorded yet.</p>
      )}

      {state.status === 'ok' && state.runs.length > 0 && (
        <div className="space-y-3">
          {state.runs.map((run) => (
            <div key={run.runId} className="border-t border-primary/15 pt-2">
              <p className="text-xs font-mono text-ink-strong font-bold">{run.runId.slice(0, 8)}</p>
              <div className="mt-1 space-y-1">
                {run.stages.map((stage, idx) => (
                  <p key={idx} className="text-[11px] font-mono text-ink-max">
                    {stage.stage.replace(/_/g, ' ')} · {stage.status} · {stage.durationMs == null ? '—' : `${(stage.durationMs / 1000).toFixed(1)}s`}{stage.detail ? ` · ${stage.detail}` : ''}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
