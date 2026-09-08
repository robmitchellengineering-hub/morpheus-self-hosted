import { useState, useEffect, useCallback } from 'react';
import { X, ListChecks, Loader2, Check, Circle, Dot, RotateCcw, Trash2, Plus } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Self-dev feature plans (SELF-DEV-V2 A1). A feature is a multi-step plan
// tracked across turns: chatWithMorpheus gives the planner the goal + steps +
// active step every build turn (server/src/lib/selfDevFeature.js), and the
// operator marks a step done here once its push is in. One active feature per
// self-dev project.
export default function SelfDevFeatureModal({ open, onClose, projectId, onActiveChange }) {
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState({ migrated: true, active: null, recent: [] });
  const [goal, setGoal] = useState('');
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const { data } = await base44.functions.invoke('getSelfDevFeatures', { projectId });
      setState(data);
      onActiveChange?.(data.active || null);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, onActiveChange]);

  useEffect(() => { if (open) { setError(null); load(); } }, [open, load]);

  if (!open) return null;

  const plan = async () => {
    if (goal.trim().length < 10) return;
    setPlanning(true);
    setError(null);
    try {
      const { data } = await base44.functions.invoke('planSelfDevFeature', { projectId, goal: goal.trim() });
      setState((s) => ({ ...s, active: data.feature }));
      onActiveChange?.(data.feature);
      setGoal('');
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setPlanning(false);
    }
  };

  const act = async (action, args = {}) => {
    if (!state.active) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await base44.functions.invoke('updateSelfDevFeature', { featureId: state.active.id, action, ...args });
      const stillActive = data.feature.status === 'active' ? data.feature : null;
      setState((s) => ({ ...s, active: stillActive, recent: stillActive ? s.recent : [data.feature, ...s.recent].slice(0, 8) }));
      onActiveChange?.(stillActive);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const f = state.active;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div className="bg-background border-l border-primary/40 w-full max-w-lg h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <ListChecks size={18} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">SELF-DEV FEATURE</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-4">
          {error && <div className="border border-red-500/40 bg-red-500/10 text-red-400 text-xs p-2">{error}</div>}

          {!state.migrated && (
            <div className="border border-yellow-500/40 bg-yellow-500/10 text-yellow-500/90 text-xs p-3 leading-relaxed">
              The <span className="font-mono">self_dev_features</span> table hasn't been created yet. Run{' '}
              <span className="font-mono">server/prisma/add-self-dev-features-table.sql</span> against the database, then reopen this panel.
            </div>
          )}

          {loading && <div className="flex items-center gap-2 text-primary/60 text-sm"><Loader2 size={14} className="animate-spin" /> Loading…</div>}

          {state.migrated && !loading && !f && (
            <div className="space-y-3">
              <p className="text-primary/70 text-sm leading-relaxed">
                Describe a feature to build on Morpheus. It'll be broken into small, shippable steps — the planner gets the goal + step list + current step on every build turn, so a multi-turn feature stays on track.
              </p>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={4}
                placeholder="e.g. Add a decisions log — every self-dev push records what changed and why, and the planner reads recent entries back."
                className="w-full bg-black/40 border border-primary/30 text-primary text-sm p-2 font-mono focus:border-primary/60 outline-none resize-y"
              />
              <button onClick={plan} disabled={planning || goal.trim().length < 10} className="flex items-center gap-1.5 text-xs px-3 h-[34px] text-black bg-primary hover:bg-primary/90 font-bold disabled:opacity-40">
                {planning ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {planning ? 'PLANNING…' : 'PLAN FEATURE'}
              </button>
            </div>
          )}

          {f && (
            <div className="space-y-3">
              <div>
                <p className="text-primary font-display tracking-wide text-sm">{f.title}</p>
                <p className="text-primary/60 text-xs mt-1 leading-relaxed">{f.goal}</p>
                <p className="text-primary/50 text-[11px] mt-1">{f.doneCount}/{f.totalSteps} steps done</p>
              </div>

              <ul className="space-y-1.5">
                {f.steps.map((s) => (
                  <li key={s.n} className={`flex items-start gap-2 border px-2.5 py-2 text-xs ${s.status === 'active' ? 'border-primary/50 bg-primary/5' : s.status === 'done' ? 'border-primary/15 text-primary/50' : 'border-primary/15 text-primary/70'}`}>
                    <span className="mt-0.5 shrink-0">
                      {s.status === 'done' ? <Check size={12} className="text-primary" /> : s.status === 'active' ? <Dot size={12} className="text-primary" /> : <Circle size={10} className="text-primary/40" />}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className={s.status === 'done' ? 'line-through' : ''}>{s.n}. {s.title}</span>
                      {s.ref && <span className="text-primary/40 ml-1">({s.ref})</span>}
                    </span>
                    {s.status !== 'done' ? (
                      <button onClick={() => act('completeStep', { stepN: s.n })} disabled={busy} title="Mark this step done" className="shrink-0 text-[10px] text-primary/70 hover:text-primary border border-primary/30 px-1.5 py-0.5 hover:bg-primary/10 disabled:opacity-40">DONE</button>
                    ) : (
                      <button onClick={() => act('reopenStep', { stepN: s.n })} disabled={busy} title="Reopen this step" className="shrink-0 text-primary/40 hover:text-primary"><RotateCcw size={11} /></button>
                    )}
                  </li>
                ))}
              </ul>

              <button onClick={() => act('abandon')} disabled={busy} className="flex items-center gap-1.5 text-[11px] text-red-400/80 hover:text-red-400 border border-red-500/30 px-2 py-1 hover:bg-red-500/10 disabled:opacity-40">
                <Trash2 size={11} /> ABANDON FEATURE
              </button>
            </div>
          )}

          {state.recent.length > 0 && (
            <div className="pt-2 border-t border-primary/15">
              <p className="text-primary/40 text-[11px] uppercase tracking-wider mb-1.5">Past features</p>
              <ul className="space-y-1">
                {state.recent.map((r) => (
                  <li key={r.id} className="text-xs text-primary/50 flex items-center gap-2">
                    <span className={`text-[10px] px-1 border ${r.status === 'done' ? 'border-primary/30 text-primary/60' : 'border-primary/15'}`}>{r.status}</span>
                    <span className="truncate">{r.title}</span>
                    <span className="text-primary/30 shrink-0">{r.doneCount}/{r.totalSteps}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
