import { useState, useEffect, useCallback } from 'react';
import { X, Rocket, Loader2, CheckCircle2, Circle, Wand2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Publish-readiness checklist (2026-09-09) — what a *shipped* build of this
// project's compile target includes, run against the current files. The list
// itself is declared by the compile-target adapter (server side), so a new
// target brings its own checklist with no change here.

export default function PublishPanel({ open, onClose, projectId, onRequestFix }) {
  const [state, setState] = useState(null); // { supported, target, items } | { error }

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const { data } = await base44.functions.invoke('getPublishChecklist', { projectId });
      setState(data);
    } catch (e) {
      setState({ error: e?.data?.error || e.message });
    }
  }, [projectId]);

  useEffect(() => { if (open) { setState(null); load(); } }, [open, load]);

  if (!open) return null;

  const items = state?.items || [];
  // Data-conditional items (privacy/terms) only count once the site actually
  // collects something — keep them off the badge and the one-click fix.
  const missing = items.filter((i) => !i.done && i.when !== 'data');
  const conditional = items.filter((i) => !i.done && i.when === 'data');
  const done = items.filter((i) => i.done);

  const requestFix = () => {
    const list = missing.map((i) => `- ${i.label}: ${i.detail}`).join('\n');
    onRequestFix?.(`Bring this site up to publish-ready standard. Add what's missing, don't touch what's already there:\n${list}\n\nUse the brand kit values and Media Library assets where relevant.`);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div className="bg-background border-l border-primary/40 w-full max-w-md h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <Rocket size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">PUBLISH CHECKLIST</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <p className="text-[11px] text-ink/45 leading-relaxed px-4 py-2 border-b border-primary/10">
          What a finished, launchable {state?.target || 'project'} includes. The builder is told these on every
          build — this is a check against the current files.
        </p>

        {!state && <div className="p-4 flex items-center gap-2 text-primary/60 text-xs"><Loader2 size={14} className="animate-spin" /> Checking…</div>}
        {state?.error && <div className="m-4 text-red-400 text-xs border border-red-500/30 px-3 py-2">{state.error}</div>}
        {state && state.supported === false && (
          <div className="m-4 text-ink/50 text-xs border border-primary/20 px-3 py-2">
            No publish checklist for the <span className="font-mono">{state.target}</span> target yet — this is mainly for web-app builds.
          </div>
        )}

        {state?.supported && (
          <>
            <div className="flex-1 overflow-y-auto scrollbar-matrix p-3 space-y-2">
              {missing.length === 0 && <div className="text-primary text-xs flex items-center gap-2"><CheckCircle2 size={14} /> Everything required is covered.</div>}
              {[...missing, ...conditional, ...done].map((i) => (
                <div key={i.id} className={`border p-2.5 ${i.done ? 'border-primary/15 bg-primary/[0.03]' : 'border-primary/25 bg-primary/5'}`}>
                  <div className="flex items-start gap-2">
                    {i.done
                      ? <CheckCircle2 size={13} className="text-primary shrink-0 mt-0.5" />
                      : <Circle size={13} className="text-primary/40 shrink-0 mt-0.5" />}
                    <div className="min-w-0">
                      <div className={`text-[11px] ${i.done ? 'text-primary/60' : 'text-primary'}`}>
                        {i.label}{i.when === 'data' ? <span className="text-primary/40"> — only if the site collects data</span> : ''}
                      </div>
                      <div className="text-[10px] text-ink/40 leading-relaxed mt-0.5">{i.detail}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {missing.length > 0 && (
              <div className="p-3 border-t border-primary/20 shrink-0">
                <button onClick={requestFix} className="flex items-center gap-1.5 px-4 py-1.5 border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-[11px] w-full justify-center">
                  <Wand2 size={12} /> GET MORPHEUS TO ADD THE {missing.length} MISSING
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
