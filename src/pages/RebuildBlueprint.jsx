import { useState, useEffect, useCallback } from 'react';
import { FileText, Loader2, Download, RefreshCw, CheckCircle, FileDown, ArrowLeft } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import jsPDF from 'jspdf';
import MatrixRain from '@/components/matrix/MatrixRain';

export default function RebuildBlueprint() {
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

  useEffect(() => { loadDoc(); }, [loadDoc]);

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

  const downloadPdf = async () => {
    if (!doc) return;
    setPdfLoading(true);
    try {
      let md = doc.content || '';
      if (doc.file_url) {
        const res = await fetch(doc.file_url);
        md = await res.text();
      }

      const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 40;
      const maxW = pageW - margin * 2;
      let y = margin;

      const ensureSpace = (h) => {
        if (y + h > pageH - margin) { pdf.addPage(); y = margin; }
      };

      for (const rawLine of md.split('\n')) {
        const line = rawLine.trimEnd();

        if (line.startsWith('# ')) {
          ensureSpace(28);
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(18);
          pdf.setTextColor(0, 180, 80);
          const wrapped = pdf.splitTextToSize(line.replace(/^# /, ''), maxW);
          for (const w of wrapped) { ensureSpace(22); pdf.text(w, margin, y); y += 22; }
          y += 6;
        } else if (line.startsWith('## ')) {
          ensureSpace(24);
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(14);
          pdf.setTextColor(0, 140, 60);
          const wrapped = pdf.splitTextToSize(line.replace(/^## /, ''), maxW);
          for (const w of wrapped) { ensureSpace(18); pdf.text(w, margin, y); y += 18; }
          y += 4;
        } else if (line.startsWith('### ')) {
          ensureSpace(20);
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(11);
          pdf.setTextColor(0, 120, 50);
          const wrapped = pdf.splitTextToSize(line.replace(/^### /, ''), maxW);
          for (const w of wrapped) { ensureSpace(15); pdf.text(w, margin, y); y += 15; }
          y += 2;
        } else if (line.startsWith('> ')) {
          pdf.setFont('helvetica', 'italic');
          pdf.setFontSize(9);
          pdf.setTextColor(100, 100, 100);
          const wrapped = pdf.splitTextToSize(line.replace(/^> /, ''), maxW);
          for (const w of wrapped) { ensureSpace(13); pdf.text(w, margin, y); y += 13; }
          y += 2;
        } else if (line.startsWith('|')) {
          const cells = line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length);
          if (cells.length > 0) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(8);
            pdf.setTextColor(40, 40, 40);
            const colW = maxW / cells.length;
            ensureSpace(14);
            for (let i = 0; i < cells.length; i++) {
              const cellText = pdf.splitTextToSize(cells[i], colW - 4)[0] || '';
              pdf.text(cellText, margin + i * colW, y);
            }
            y += 12;
          }
        } else if (line.startsWith('---')) {
          ensureSpace(10);
          pdf.setDrawColor(0, 180, 80);
          pdf.setLineWidth(0.5);
          pdf.line(margin, y, margin + maxW, y);
          y += 10;
        } else if (line.trim() === '') {
          y += 6;
        } else {
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(9);
          pdf.setTextColor(30, 30, 30);
          const wrapped = pdf.splitTextToSize(line, maxW);
          for (const w of wrapped) { ensureSpace(13); pdf.text(w, margin, y); y += 13; }
        }
      }

      pdf.save(`morpheus-rebuild-${(doc.version || 'blueprint').replace(/[:.]/g, '-')}.pdf`);
    } catch (e) {
      setError('PDF generation failed: ' + e.message);
    } finally {
      setPdfLoading(false);
    }
  };

  const downloadMd = async () => {
    if (!doc) return;
    if (doc.file_url) {
      const a = document.createElement('a');
      a.href = doc.file_url;
      a.download = `morpheus-rebuild-${doc.version || 'doc'}.md`;
      a.target = '_blank';
      a.click();
      return;
    }
    if (!doc.content) return;
    const blob = new Blob([doc.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `morpheus-rebuild-${doc.version || 'doc'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sizeKb = doc?.content_size ? (doc.content_size / 1024).toFixed(1) : '0';

  return (
    <div className="relative min-h-screen bg-background text-ink font-mono">
      <MatrixRain opacity={0.04} />
      <div className="relative z-10 max-w-3xl mx-auto px-6 py-12 safe-top">
        <Link to="/" className="inline-flex items-center gap-1.5 text-primary/60 hover:text-primary text-sm mb-6 transition-colors">
          <ArrowLeft size={14} /> BACK
        </Link>

        <div className="flex items-center gap-3 mb-2">
          <FileText size={24} className="text-primary neon-glow" />
          <h1 className="text-2xl md:text-3xl font-display tracking-widest neon-glow text-heading">REBUILD BLUEPRINT</h1>
        </div>
        <p className="text-ink/60 text-sm mb-8">
          // The complete standalone reconstruction blueprint for Morpheus itself. Drop this + the published APK into any AI agent to rebuild the full stack without Base44.
        </p>

        {loading && (
          <div className="flex items-center gap-2 text-ink/60 text-sm py-12 justify-center">
            <Loader2 size={16} className="animate-spin" /> Loading blueprint...
          </div>
        )}

        {error && (
          <div className="text-red-500 text-sm border border-red-500/30 px-3 py-2 mb-4">{error}</div>
        )}

        {!loading && doc && (
          <div className="space-y-4 mb-6">
            <div className="flex items-center gap-2 text-xs text-ink/60">
              <CheckCircle size={14} className="text-primary" />
              Version: <span className="text-ink">{new Date(doc.version).toLocaleString()}</span>
              <span className="text-primary/65">|</span>
              {sizeKb} KB
            </div>
            <div className="border border-primary/20 bg-primary/5 p-4 max-h-80 overflow-y-auto scrollbar-matrix text-xs text-ink/70 font-mono whitespace-pre-wrap">
              {doc.content?.substring(0, 3000)}{doc.content?.length > 3000 ? '\n\n... (truncated — download for full document)' : ''}
            </div>
          </div>
        )}

        {!loading && !doc && !error && (
          <p className="text-ink/75 text-sm italic text-center py-12">No blueprint generated yet. Press GENERATE to create one.</p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={generate}
            disabled={generating}
            className="flex items-center gap-2 px-5 py-2.5 border border-primary text-primary hover:bg-primary hover:text-black transition-colors font-bold text-sm disabled:opacity-50"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {doc ? 'REGENERATE' : 'GENERATE'}
          </button>
          <button
            onClick={downloadPdf}
            disabled={!doc || pdfLoading}
            className="flex items-center gap-2 px-5 py-2.5 bg-primary text-black hover:bg-[#39ff14] transition-colors font-bold text-sm disabled:opacity-30"
          >
            {pdfLoading ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />} DOWNLOAD PDF
          </button>
          <button
            onClick={downloadMd}
            disabled={!doc}
            className="flex items-center gap-2 px-5 py-2.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary transition-colors text-sm disabled:opacity-30"
          >
            <Download size={14} /> DOWNLOAD .MD
          </button>
        </div>
      </div>
    </div>
  );
}