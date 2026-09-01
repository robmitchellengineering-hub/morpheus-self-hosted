import { useState, useEffect, useCallback } from 'react';
import { FileText, X, Loader2, Download, RefreshCw, CheckCircle, FileDown } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import jsPDF from 'jspdf';

export default function RebuildDocDialog({ open, onClose }) {
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
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

  const downloadPdf = async () => {
    if (!doc) return;
    setPdfLoading(true);
    try {
      // Fetch the full markdown content
      let md = doc.content || '';
      if (doc.file_url) {
        const res = await fetch(doc.file_url);
        md = await res.text();
      }

      const docPdf = new jsPDF({ unit: 'pt', format: 'a4' });
      const pageW = docPdf.internal.pageSize.getWidth();
      const pageH = docPdf.internal.pageSize.getHeight();
      const margin = 40;
      const maxW = pageW - margin * 2;
      let y = margin;

      const ensureSpace = (h) => {
        if (y + h > pageH - margin) { docPdf.addPage(); y = margin; }
      };

      for (const rawLine of md.split('\n')) {
        const line = rawLine.trimEnd();

        if (line.startsWith('# ')) {
          ensureSpace(28);
          docPdf.setFont('helvetica', 'bold');
          docPdf.setFontSize(18);
          docPdf.setTextColor(0, 180, 80);
          const wrapped = docPdf.splitTextToSize(line.replace(/^# /, ''), maxW);
          for (const w of wrapped) { ensureSpace(22); docPdf.text(w, margin, y); y += 22; }
          y += 6;
        } else if (line.startsWith('## ')) {
          ensureSpace(24);
          docPdf.setFont('helvetica', 'bold');
          docPdf.setFontSize(14);
          docPdf.setTextColor(0, 140, 60);
          const wrapped = docPdf.splitTextToSize(line.replace(/^## /, ''), maxW);
          for (const w of wrapped) { ensureSpace(18); docPdf.text(w, margin, y); y += 18; }
          y += 4;
        } else if (line.startsWith('### ')) {
          ensureSpace(20);
          docPdf.setFont('helvetica', 'bold');
          docPdf.setFontSize(11);
          docPdf.setTextColor(0, 120, 50);
          const wrapped = docPdf.splitTextToSize(line.replace(/^### /, ''), maxW);
          for (const w of wrapped) { ensureSpace(15); docPdf.text(w, margin, y); y += 15; }
          y += 2;
        } else if (line.startsWith('> ')) {
          docPdf.setFont('helvetica', 'italic');
          docPdf.setFontSize(9);
          docPdf.setTextColor(100, 100, 100);
          const wrapped = docPdf.splitTextToSize(line.replace(/^> /, ''), maxW);
          for (const w of wrapped) { ensureSpace(13); docPdf.text(w, margin, y); y += 13; }
          y += 2;
        } else if (line.startsWith('|')) {
          const cells = line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length);
          if (cells.length > 0) {
            docPdf.setFont('helvetica', 'normal');
            docPdf.setFontSize(8);
            docPdf.setTextColor(40, 40, 40);
            const colW = maxW / cells.length;
            ensureSpace(14);
            for (let i = 0; i < cells.length; i++) {
              const cellText = docPdf.splitTextToSize(cells[i], colW - 4)[0] || '';
              docPdf.text(cellText, margin + i * colW, y);
            }
            y += 12;
          }
        } else if (line.startsWith('---')) {
          ensureSpace(10);
          docPdf.setDrawColor(0, 180, 80);
          docPdf.setLineWidth(0.5);
          docPdf.line(margin, y, margin + maxW, y);
          y += 10;
        } else if (line.trim() === '') {
          y += 6;
        } else {
          docPdf.setFont('helvetica', 'normal');
          docPdf.setFontSize(9);
          docPdf.setTextColor(30, 30, 30);
          const wrapped = docPdf.splitTextToSize(line, maxW);
          for (const w of wrapped) { ensureSpace(13); docPdf.text(w, margin, y); y += 13; }
        }
      }

      docPdf.save(`morpheus-rebuild-${(doc.version || 'blueprint').replace(/[:.]/g, '-')}.pdf`);
    } catch (e) {
      setError('PDF generation failed: ' + e.message);
    } finally {
      setPdfLoading(false);
    }
  };

  if (!open) return null;

  const sizeKb = doc?.content_size ? (doc.content_size / 1024).toFixed(1) : '0';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-2xl border border-primary/40 bg-background shadow-[0_0_20px_rgba(0,255,65,0.2)] flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider neon-glow">REBUILD BLUEPRINT</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto scrollbar-matrix">
          <p className="text-xs text-primary/50">
            // A living blueprint of Morpheus's full architecture. Drop this + the published APK into any AI agent to reconstruct the backend as a standalone self-hosted application.
          </p>

          {loading && (
            <div className="flex items-center gap-2 text-primary/60 text-sm py-8 justify-center">
              <Loader2 size={16} className="animate-spin" /> Loading blueprint...
            </div>
          )}

          {error && (
            <div className="text-red-500 text-sm border border-red-500/30 px-3 py-2">{error}</div>
          )}

          {!loading && doc && (
            <>
              <div className="flex items-center gap-2 text-xs text-primary/60">
                <CheckCircle size={14} className="text-primary" />
                Version: <span className="text-primary">{new Date(doc.version).toLocaleString()}</span>
                <span className="text-primary/65">|</span>
                {sizeKb} KB
              </div>
              <div className="border border-primary/20 bg-primary/5 p-3 max-h-64 overflow-y-auto scrollbar-matrix text-xs text-primary/70 font-mono whitespace-pre-wrap">
                {doc.content.substring(0, 2000)}{doc.content.length > 2000 ? '\n\n... (truncated — download for full document)' : ''}
              </div>
            </>
          )}

          {!loading && !doc && !error && (
            <p className="text-primary/75 text-sm italic text-center py-8">No blueprint generated yet. Press GENERATE to create one.</p>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-primary/20 px-4 py-3 shrink-0">
          <button
            onClick={generate}
            disabled={generating}
            className="flex items-center gap-2 px-4 py-2 border border-primary text-primary hover:bg-primary hover:text-black transition-colors font-bold text-sm disabled:opacity-50"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {doc ? 'REGENERATE' : 'GENERATE'}
          </button>
          <button
            onClick={download}
            disabled={!doc}
            className="flex items-center gap-2 px-4 py-2 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary transition-colors text-sm disabled:opacity-30"
          >
            <Download size={14} /> DOWNLOAD .MD
          </button>
          <button
            onClick={downloadPdf}
            disabled={!doc || pdfLoading}
            className="flex items-center gap-2 px-4 py-2 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary transition-colors text-sm disabled:opacity-30"
          >
            {pdfLoading ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />} DOWNLOAD PDF
          </button>
        </div>
      </div>
    </div>
  );
}