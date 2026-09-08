import { useState } from 'react';
import { X, History, Search, Camera, RotateCcw, Loader2 } from 'lucide-react';
import ChatHistoryTab from '@/components/matrix/ChatHistoryTab';

// Self-dev's own history panel. The general-purpose HistoryPanel defaults to
// a BUILD LOGS tab backed by getBuildLogs(), which needs the project to be
// owned by the caller — self-dev's singleton project is found through the
// admin-bypass entity API and doesn't always satisfy that, so that tab came
// up empty and "history" looked broken. This panel drops the build-logs
// dependency entirely: searchable chat history (the record that actually
// matters here — Command Deck 4.0 §Self-Dev Improvements #2) plus snapshot
// restore, both driven off data the self-dev workspace already has loaded.
export default function SelfDevHistoryModal({ open, onClose, project, snapshots, onRestore }) {
  const [tab, setTab] = useState('history');
  const [confirmId, setConfirmId] = useState(null);
  const [restoringId, setRestoringId] = useState(null);

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
          <button
            onClick={() => setTab('history')}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs tracking-wider transition-colors ${tab === 'history' ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-primary/75 hover:text-primary'}`}
          >
            <Search size={14} /> CHAT HISTORY
          </button>
          <button
            onClick={() => setTab('snapshots')}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs tracking-wider transition-colors ${tab === 'snapshots' ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-primary/75 hover:text-primary'}`}
          >
            <Camera size={14} /> SNAPSHOTS ({snapshots.length})
          </button>
        </div>

        {tab === 'history' ? (
          <ChatHistoryTab project={project} />
        ) : (
          <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-2">
            {snapshots.length === 0 ? (
              <p className="text-primary/75 italic text-sm">No snapshots yet. Morpheus captures one before every build.</p>
            ) : (
              snapshots.map((s) => (
                <div key={s.id} className="border border-primary/20 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-primary text-sm truncate">{s.label}</p>
                      <p className="text-primary/75 text-xs mt-0.5">{new Date(s.created_date).toLocaleString()}</p>
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
