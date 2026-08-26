import { useState, useEffect, useCallback } from 'react';
import { FileText, X, Loader2, Download, RefreshCw, CheckCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function RebuildDocDialog({ open, onClose }) {
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);

  const loadDoc = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await base44.entities.RebuildDoc.list('-created_date', 1);
      setDoc(list.length > 0 ? list[0] : null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadDoc();
  }, [open, loadDoc]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      await base44.functions.invoke('generateRebuildDoc', {});
      await loadDoc();
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  };

  const download = async () => {
    if (!doc) return;
    // Download the full blueprint from the stored file URL
    if (doc.file_url) {
      const a = document.createElement('a');
      a.href = doc.file_url;
      a.download = `morpheus-rebuild-${doc.version || 'doc'}.md`;
      a.target = '_blank';
      a.click();
      return;
    }
    // Fallback: download the inline content (legacy docs without file_url)
    if (!doc.content) return;
    const blob = new Blob([doc.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `morpheus-rebuild-${doc.version || 'doc'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!open) return null;

  const sizeKb = doc?.content_size ? (doc.content_size / 1024).toFixed(1) : '0';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-2xl border border-[#00ff41]/40 bg-black shadow-[0_0_20px_rgba(0,255,65,0.2)] flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b border-[#00ff41]/20 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-[#00ff41]" />
            <span className="text-[#00ff41] font-display tracking-wider neon-glow">REBUILD BLUEPRINT</span>
          </div>
          <button onClick={onClose} className="text-[#00ff41]/60 hover:text-[#00ff41]"><X size={18} /></button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto scrollbar-matrix">
          <p className="text-xs text-[#00ff41]/50">
            // A living blueprint of Morpheus's full architecture. Drop this + the published APK into any AI agent to reconstruct the backend as a standalone self-hosted application.
          </p>

          {loading && (
            <div className="flex items-center gap-2 text-[#00ff41]/60 text-sm py-8 justify-center">
              <Loader2 size={16} className="animate-spin" /> Loading blueprint...
            </div>
          )}

          {error && (
            <div className="text-red-500 text-sm border border-red-500/30 px-3 py-2">{error}</div>
          )}

          {!loading && doc && (
            <>
              <div className="flex items-center gap-2 text-xs text-[#00ff41]/60">
                <CheckCircle size={14} className="text-[#00ff41]" />
                Version: <span className="text-[#00ff41]">{new Date(doc.version).toLocaleString()}</span>
                <span className="text-[#00ff41]/65">|</span>
                {sizeKb} KB
              </div>
              <div className="border border-[#00ff41]/20 bg-[#00ff41]/5 p-3 max-h-64 overflow-y-auto scrollbar-matrix text-xs text-[#00ff41]/70 font-mono whitespace-pre-wrap">
                {doc.content.substring(0, 2000)}{doc.content.length > 2000 ? '\n\n... (truncated — download for full document)' : ''}
              </div>
            </>
          )}

          {!loading && !doc && !error && (
            <p className="text-[#00ff41]/75 text-sm italic text-center py-8">No blueprint generated yet. Press GENERATE to create one.</p>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-[#00ff41]/20 px-4 py-3 shrink-0">
          <button
            onClick={generate}
            disabled={generating}
            className="flex items-center gap-2 px-4 py-2 border border-[#00ff41] text-[#00ff41] hover:bg-[#00ff41] hover:text-black transition-colors font-bold text-sm disabled:opacity-50"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {doc ? 'REGENERATE' : 'GENERATE'}
          </button>
          <button
            onClick={download}
            disabled={!doc}
            className="flex items-center gap-2 px-4 py-2 border border-[#00ff41]/50 text-[#00ff41]/80 hover:border-[#00ff41] hover:text-[#00ff41] transition-colors text-sm disabled:opacity-30"
          >
            <Download size={14} /> DOWNLOAD .MD
          </button>
        </div>
      </div>
    </div>
  );
}