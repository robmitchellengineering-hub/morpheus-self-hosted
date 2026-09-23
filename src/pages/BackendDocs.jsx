import { useState, useEffect } from 'react';
import { FileText, Loader2, Download } from 'lucide-react';
import jsPDF from 'jspdf';
import MatrixRain from '@/components/matrix/MatrixRain';

export default function BackendDocs() {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    fetch('/docs/backend-functions-reference.md')
      .then(r => r.text())
      .then(t => { setContent(t); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleDownload = () => {
    if (!content) return;
    setGenerating(true);

    setTimeout(() => {
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 48;
      const usableW = pageW - margin * 2;
      let y = margin;

      const lines = content.split('\n');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      const lineH = 12;

      for (const line of lines) {
        // Page break
        if (y + lineH > pageH - margin) {
          doc.addPage();
          y = margin;
        }

        // Headings
        if (line.startsWith('# ')) {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(18);
          doc.setTextColor(0, 100, 0);
          const wrapped = doc.splitTextToSize(line.replace(/^#+\s*/, ''), usableW);
          doc.text(wrapped, margin, y);
          y += wrapped.length * 22 + 8;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(20, 20, 20);
        } else if (line.startsWith('## ')) {
          if (y + 30 > pageH - margin) { doc.addPage(); y = margin; }
          y += 8;
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(14);
          doc.setTextColor(0, 80, 0);
          const wrapped = doc.splitTextToSize(line.replace(/^#+\s*/, ''), usableW);
          doc.text(wrapped, margin, y);
          y += wrapped.length * 18 + 6;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(20, 20, 20);
        } else if (line.startsWith('### ')) {
          if (y + 24 > pageH - margin) { doc.addPage(); y = margin; }
          y += 4;
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(11);
          doc.setTextColor(0, 60, 0);
          const wrapped = doc.splitTextToSize(line.replace(/^#+\s*/, ''), usableW);
          doc.text(wrapped, margin, y);
          y += wrapped.length * 14 + 4;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(20, 20, 20);
        } else if (line.startsWith('> ')) {
          doc.setFont('helvetica', 'italic');
          doc.setFontSize(8.5);
          doc.setTextColor(80, 80, 80);
          const wrapped = doc.splitTextToSize(line.replace(/^>\s*/, ''), usableW);
          doc.text(wrapped, margin, y);
          y += wrapped.length * lineH;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(20, 20, 20);
        } else if (line.startsWith('|')) {
          doc.setFont('courier', 'normal');
          doc.setFontSize(7.5);
          doc.setTextColor(40, 40, 40);
          const wrapped = doc.splitTextToSize(line, usableW);
          doc.text(wrapped, margin, y);
          y += wrapped.length * 10;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(20, 20, 20);
        } else if (line.startsWith('---')) {
          y += 4;
          doc.setDrawColor(0, 100, 0);
          doc.setLineWidth(0.5);
          doc.line(margin, y, pageW - margin, y);
          y += 10;
        } else if (line.trim() === '') {
          y += 6;
        } else {
          const wrapped = doc.splitTextToSize(line, usableW);
          if (y + wrapped.length * lineH > pageH - margin) {
            doc.addPage();
            y = margin;
          }
          doc.text(wrapped, margin, y);
          y += wrapped.length * lineH;
        }
      }

      doc.save('morpheus-backend-functions-reference.pdf');
      setGenerating(false);
    }, 100);
  };

  return (
    <div className="relative min-h-screen bg-background text-primary font-mono overflow-hidden">
      <MatrixRain opacity={0.04} />
      <div className="relative z-10 max-w-2xl mx-auto px-6 py-16 safe-top flex flex-col items-center justify-center min-h-screen text-center">
        <FileText size={48} className="text-primary mb-4 neon-glow" />
        <h1 className="text-2xl font-display tracking-widest neon-glow mb-2 text-heading">BACKEND FUNCTIONS REFERENCE</h1>
        <p className="text-ink/60 text-sm mb-8">// Complete documentation of all 35 backend functions — logic, inputs, outputs, and internal flows.</p>
        {loading ? (
          <div className="flex items-center gap-2 text-primary/60">
            <Loader2 size={16} className="animate-spin" /> loading document...
          </div>
        ) : (
          <button
            onClick={handleDownload}
            disabled={generating}
            className="flex items-center gap-2 px-6 py-3 bg-primary text-black hover:bg-[#39ff14] font-bold transition-colors shadow-[0_0_24px_-6px_rgba(0,255,65,0.5)] disabled:opacity-50"
          >
            {generating ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
            {generating ? 'GENERATING PDF...' : 'DOWNLOAD PDF'}
          </button>
        )}
        {!loading && !generating && (
          <p className="text-ink/40 text-xs mt-4">~{Math.round(content.length / 1000)}KB · 35 functions · 15 shared modules</p>
        )}
      </div>
    </div>
  );
}