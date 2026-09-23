import { useState } from 'react';
import { FlaskConical, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

export default function TestsPanel({ open, onClose, project, onGenerate }) {
  const [spec, setSpec] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  if (!open) return null;

  const handleGenerate = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await onGenerate(spec);
      setResult(res);
    } catch (e) {
      setError(e.message || 'Test generation failed');
    } finally {
      setRunning(false);
    }
  };

  const handleClose = () => {
    setSpec('');
    setResult(null);
    setError(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onClick={handleClose}>
      <div className="w-full max-w-2xl bg-background border border-primary neon-border max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/30 shrink-0">
          <div className="flex items-center gap-2">
            <FlaskConical size={18} className="text-primary" />
            <span className="text-primary font-display tracking-wider">GENERATE TESTS + CI</span>
          </div>
          <button onClick={handleClose} className="text-primary/60 hover:text-primary">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto scrollbar-matrix p-4 space-y-4">
          <div>
            <label className="text-xs text-primary/60 uppercase tracking-wider mb-1 block">SPEC (OPTIONAL)</label>
            <textarea
              value={spec}
              onChange={e => setSpec(e.target.value)}
              placeholder="// e.g. focus on the API layer, include edge cases for auth..."
              className="w-full h-24 bg-background text-ink text-sm border border-primary/30 px-3 py-2 outline-none focus:border-primary/60 resize-none scrollbar-matrix"
              disabled={running}
            />
            <p className="text-xs text-ink/75 mt-1">// Morpheus will analyze all files and generate tests + CI pipeline</p>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-red-500 text-sm border border-red-500/30 p-3">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 text-ink text-sm border border-primary/30 p-3">
                <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
                <div>
                  <p>{result.reply}</p>
                  {result.testCount > 0 && (
                    <p className="text-xs text-ink/50 mt-1">{result.testCount} test file(s) generated</p>
                  )}
                  {result.fileOperations?.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {result.fileOperations.map((op, i) => (
                        <div key={i} className="text-xs text-ink/60 font-mono">
                          <span className="text-ink/75">[{op.action}]</span> {op.path}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-primary/30 shrink-0">
          <button
            onClick={handleGenerate}
            disabled={running}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-primary text-black font-bold tracking-wider hover:bg-[#39ff14] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? (
              <><Loader2 size={16} className="animate-spin" /> GENERATING...</>
            ) : (
              <><FlaskConical size={16} /> GENERATE TEST SUITE</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}