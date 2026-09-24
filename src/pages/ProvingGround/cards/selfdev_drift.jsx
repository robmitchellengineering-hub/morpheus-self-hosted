import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Workspace drift card — "is the self-dev workspace still the commit it claims to be?"
//
// KNOWN-HAZARDS.md H9 is the incident this card makes visible: a push computed
// against a stale workspace mirror deletes whatever landed upstream since. The
// guard that refuses that push is server/src/lib/selfDevDrift.js, backed by
// Project.synced_commit. This reads the other half of the same question, at the
// file: of the files in the self-dev workspace, how many no longer match the
// content they were last synced from.
//
// Three outcomes, deliberately distinct — the same reason selfdev_runs
// distinguishes them. The request can fail, the endpoint can be unable to answer,
// or it can answer with a number. "Could not answer" must never render as
// "clean": that would be a page reporting a green workspace it never read.
export default function SelfdevDrift() {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    base44.functions.invoke('getSelfDevDrift', {})
      .then(({ data }) => {
        if (!alive) return;
        if (!data || data.available === false) {
          setState({ status: 'unavailable', reason: (data && data.reason) || 'the endpoint gave no reason' });
          return;
        }
        setState({ status: 'ok', ...data });
      })
      .catch((err) => {
        if (alive) setState({ status: 'error', message: err.message });
      });
    return () => { alive = false; };
  }, []);

  const clean = state.status === 'ok'
    && (state.driftCount || 0) + (state.unknownCount || 0) === 0;

  return (
    <div className="space-y-2">
      {state.status === 'loading' && (
        <p className="text-xs text-ink-strong">Reading the workspace…</p>
      )}

      {state.status === 'error' && (
        <p className="text-xs text-ink-strong">Failed to load: {state.message}</p>
      )}

      {state.status === 'unavailable' && (
        <p className="text-xs text-ink-strong">{state.reason}</p>
      )}

      {state.status === 'ok' && (
        <>
          <p className="flex items-start gap-2 text-xs font-mono text-ink-strong">
            {clean
              ? <CheckCircle2 size={12} className="text-primary mt-0.5 shrink-0" />
              : <AlertTriangle size={12} className="text-amber-400 mt-0.5 shrink-0" />}
            <span>{state.verdict || 'no verdict returned'}</span>
          </p>
          <p className="text-[11px] font-mono text-ink-max">
            {state.driftCount} of {state.totalFiles} file(s) differ from the commit they were synced from
          </p>
          {state.unknownCount > 0 && (
            <p className="text-[11px] font-mono text-ink-max">
              {state.unknownCount} file(s) have no recorded sync point — changed or not is genuinely unknown
            </p>
          )}
          {state.skippedFiles > 0 && (
            <p className="text-[11px] font-mono text-ink-max">
              {state.skippedFiles} file(s) with content held in storage were skipped (not comparable here)
            </p>
          )}
        </>
      )}
    </div>
  );
}
