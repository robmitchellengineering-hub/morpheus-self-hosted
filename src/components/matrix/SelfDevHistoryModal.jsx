import { useState, useEffect } from 'react';
import { X, History, Search, Camera, RotateCcw, Loader2, ListChecks } from 'lucide-react';
import ChatHistoryTab from '@/components/matrix/ChatHistoryTab';
import { base44 } from '@/api/base44Client';

// Self-dev's own history panel. The general-purpose HistoryPanel defaults to
// a BUILD LOGS tab backed by getBuildLogs(), which needs the project to be
// owned by the caller — self-dev's singleton project is found through the
// admin-bypass entity API and doesn't always satisfy that, so that tab came
// up empty and "history" looked broken. This panel drops the build-logs
// dependency entirely: searchable chat history, snapshot restore, and the
// decisions log (Tier 2 #7) — all driven off data the self-dev workspace
// already has or a single admin call.
export default function SelfDevHistoryModal({ open, onClose, project, snapshots, onRestore }) {
  const [tab, setTab] = useState('history');
  const [confirmId, setConfirmId] = useState(null);
  const [restoringId, setRestoringId] = useState(null);
  const [decisions, setDecisions] = useState(null); // null = not loaded, { migrated, decisions }

  useEffect(() => {
    if (!open || tab !== 'decisions' || decisions || !project?.id) return;
    base44.functions.invoke('getSelfDevDecisions', { projectId: project.id })
      .then(({ data }) => setDecisions(data))
      .catch((e) => setDecisions({ migrated: true, decisions: [], error: e?.response?.data?.error || e.message }));
  }, [open, tab, decisions, project?.id]);

  if (!open) return null;

  const handleRestore = async (id) => {
    setRestoringId(id);
    try {
      await onRestore(id);
      setConfirmId(null);
      onClose();
    } finally {
      setRestoringId(null);
    }
  };

  const TabBtn = ({ id, icon: Icon, label }) => (
    <button
      onClick={() => setTab(id)}
      className={`flex items-center gap-1.5 px-4 py-2.5 text-xs tracking-wider transition-colors ${tab === id ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-primary/75 hover:text-primary'}`}
    >
      <Icon size={14} /> {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div className="bg-background border-l border-primary/40 w-full max-w-lg h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <History size={18} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">SELF-DEV HISTORY</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <div className="flex border-b border-primary/20 shrink-0">
          <TabBtn id="history" icon={Search} label="CHAT HISTORY" />
          <TabBtn id="decisions" icon={ListChecks} label="DECISIONS" />
          <TabBtn id="snapshots" icon={Camera} label={`SNAPSHOTS (${snapshots.length})`} />
        </div>

        {tab === 'history' && <ChatHistoryTab project={project} />}

        {tab === 'decisions' && (
          <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-2">
            {!decisions && <div className="flex items-center gap-2 text-ink/60 text-sm"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
            {decisions && !decisions.migrated && (
              <div className="border border-yellow-500/40 bg-yellow-500/10 text-yellow-500/90 text-xs p-3 leading-relaxed">
                The <span className="font-mono">self_dev_decisions</span> table hasn't been created yet. Run{' '}
                <span className="font-mono">server/prisma/add-self-dev-decisions-table.sql</span> against the database.
              </div>
            )}
            {decisions?.migrated && decisions.decisions.length === 0 && (
              <p className="text-ink/75 italic text-sm">No decisions logged yet. Each self-dev change that ships records what it did and why here, and the recent ones are fed back to the planner.</p>
            )}
            {decisions?.decisions?.map((d) => (
              <div key={d.id} className="border border-primary/20 p-3">
                <p className="text-ink text-sm">{d.summary}</p>
                {d.rationale && d.rationale !== '—' && <p className="text-ink/60 text-xs mt-1 leading-relaxed">{d.rationale}</p>}
                <p className="text-ink/40 text-[11px] mt-1.5">
                  {new Date(d.created_date).toLocaleString()}{d.ref ? ` · ${d.ref}` : ' · not yet shipped'}
                </p>
              </div>
            ))}
          </div>
        )}

        {tab === 'snapshots' && (
          <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-2">
            {snapshots.length === 0 ? (
              <p className="text-ink/75 italic text-sm">No snapshots yet. Morpheus captures one before every build.</p>
            ) : (
              snapshots.map((s) => (
                <div key={s.id} className="border border-primary/20 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-ink text-sm truncate">{s.label}</p>
                      <p className="text-ink/75 text-xs mt-0.5">{new Date(s.created_date).toLocaleString()}</p>
                    </div>
                    {confirmId === s.id ? (
                      <div className="flex gap-1 shrink-0">
                        <button onClick={() => handleRestore(s.id)} disabled={restoringId === s.id} className="text-xs text-black bg-primary px-2 py-1 font-bold disabled:opacity-50 flex items-center gap-1">
                          {restoringId === s.id ? <Loader2 size={11} className="animate-spin" /> : null} RESTORE
                        </button>
                        <button onClick={() => setConfirmId(null)} disabled={restoringId === s.id} className="text-xs text-primary/60 hover:text-primary px-2 py-1 border border-primary/30">CANCEL</button>
                      </div>
                    ) : (
                      <button onClick={() => setConfirmId(s.id)} className="text-primary/60 hover:text-primary shrink-0" title="Restore this version of the workspace">
                        <RotateCcw size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
