import { useState } from 'react';
import { Camera, Loader2, Download, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import MatrixRain from '@/components/matrix/MatrixRain';
import { base44 } from '@/api/base44Client';
import { PLATFORMS } from '@/components/matrix/ConnectionsSection';

const STATIC_ROUTES = [
  { path: '/', label: 'Landing' },
  { path: '/workspace', label: 'Workspace — Project List' },
  { path: '/architect', label: 'Architect — Backend Constructs' },
  { path: '/market', label: 'Market — Template Store' },
  { path: '/settings', label: 'Settings — Configuration' },
  { path: '/backend-docs', label: 'Backend Functions Reference' },
  { path: '/rebuild-blueprint', label: 'Rebuild Blueprint' },
];

export default function Screenshots() {
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [pageCount, setPageCount] = useState(0);
  const [pdfUrl, setPdfUrl] = useState(null);

  // Load a route into the iframe at the given viewport, wait for render, then
  // capture with html2canvas. The iframe is resized BEFORE loading so the
  // app's responsive CSS applies at the target breakpoint.
  // Detect visible Tailwind animate-spin elements (loading spinners) in the
  // iframe document. Returns true while the page is still loading data.
  const hasSpinner = (doc) => {
    const spins = doc.querySelectorAll('.animate-spin');
    for (const el of spins) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  };

  // Load a route into the iframe at the given viewport, wait for the page to
  // finish loading (spinners gone), run an optional afterLoad hook, then
  // capture with html2canvas. The iframe is resized BEFORE loading so the
  // app's responsive CSS applies at the target breakpoint.
  const captureRoute = (iframe, path, width, height, opts = {}, waitMs = 3500) => new Promise((resolve) => {
    const { afterLoad, fullHeight } = opts;
    let done = false;
    iframe.style.width = width + 'px';
    iframe.style.height = height + 'px';
    const finish = async () => {
      if (done) return;
      done = true;
      try {
        const doc = iframe.contentDocument;
        const win = iframe.contentWindow;
        if (!doc || !doc.body) { resolve(null); return; }
        // Poll for loading spinners to disappear (up to 25s — protected routes
        // need time for the iframe's AuthProvider to read the token from
        // localStorage and call base44.auth.me()). Requires two consecutive
        // spinner-free checks (800ms stable) so we don't capture during a
        // brief gap between Suspense fallback and data-fetch spinner.
        const pollStart = Date.now();
        const maxPoll = 25000;
        let stableCount = 0;
        while (Date.now() - pollStart < maxPoll) {
          await new Promise(r => setTimeout(r, 400));
          if (!hasSpinner(doc)) {
            stableCount++;
            if (stableCount >= 2) break;
          } else {
            stableCount = 0;
          }
        }
        // Detect if the iframe was redirected to login (auth failed in iframe)
        const currentPath = win?.location?.pathname || '';
        if (currentPath.includes('/login') || currentPath.includes('/reset-password')) {
          console.warn(`[screenshots] Auth redirect for ${path} → ${currentPath}`);
          resolve(null);
          return;
        }
        // afterLoad runs once content has settled (e.g. expanding a platform)
        if (afterLoad) { try { await afterLoad(doc, win); } catch { /* ignore */ } }
        if (win) win.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 300));
        const captureHeight = fullHeight ? Math.max(doc.body.scrollHeight, height) : height;
        const canvas = await html2canvas(doc.body, {
          width,
          height: captureHeight,
          windowWidth: width,
          windowHeight: captureHeight,
          useCORS: true,
          backgroundColor: '#000000',
          scale: 1,
          logging: false,
        });
        resolve(canvas);
      } catch (e) {
        resolve(null);
      }
    };
    iframe.onload = () => setTimeout(finish, 2500);
    iframe.src = path;
    // Fallback in case onload doesn't fire (cached/same-route)
    setTimeout(finish, waitMs + 25000);
  });

  // Click the expand button for a given platform label inside the loaded
  // Settings page so its credential input fields become visible.
  const expandPlatform = (label) => async (doc) => {
    const buttons = doc.querySelectorAll('button');
    for (const btn of buttons) {
      const span = btn.querySelector('span');
      if (span && span.textContent.trim() === label) {
        btn.click();
        await new Promise(r => setTimeout(r, 400));
        return;
      }
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setProgress(0);
    setPageCount(0);
    if (pdfUrl) { URL.revokeObjectURL(pdfUrl); setPdfUrl(null); }

    // Build route list — include workspace-with-project if one exists
    const routes = [...STATIC_ROUTES];
    try {
      const projects = await base44.entities.Project.list('-updated_date', 1);
      if (projects.length > 0) {
        routes.splice(2, 0, { path: `/workspace/${projects[0].id}`, label: 'Workspace — Project Open' });
      }
    } catch (e) { /* not authenticated or no projects — skip */ }

    // Hidden iframe to load each route. Positioned off-screen (not opacity:0,
    // which lets the browser skip rendering content entirely — producing blank
    // captures, especially on protected routes that need auth to initialize).
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:0;left:-9999px;width:1280px;height:800px;border:none;z-index:-1;opacity:0.01;pointer-events:none;';
    document.body.appendChild(iframe);

    const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 20;

    // Each route is captured at both desktop and mobile viewports
    const VIEWPORTS = [
      { width: 1280, height: 800, label: 'Desktop' },
      { width: 384, height: 800, label: 'Mobile' },
    ];

    const totalCaptures = routes.length * VIEWPORTS.length + PLATFORMS.length;

    const addCanvasPage = (canvas, fullLabel) => {
      if (!canvas) return;
      if (captured > 0) pdf.addPage();
      pdf.setFontSize(9);
      pdf.setTextColor(0, 180, 50);
      pdf.text(fullLabel, margin, margin + 4);
      const imgData = canvas.toDataURL('image/jpeg', 0.85);
      const maxW = pageW - margin * 2;
      const maxH = pageH - margin * 2 - 16;
      const ratio = Math.min(maxW / canvas.width, maxH / canvas.height);
      const imgW = canvas.width * ratio;
      const imgH = canvas.height * ratio;
      const x = margin + (maxW - imgW) / 2;
      pdf.addImage(imgData, 'JPEG', x, margin + 16, imgW, imgH);
      captured++;
      setPageCount(captured);
    };

    let captured = 0;
    let step = 0;
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      for (const vp of VIEWPORTS) {
        step++;
        const fullLabel = `${route.label} — ${vp.label}`;
        setStatus(`Capturing: ${fullLabel}`);
        const canvas = await captureRoute(iframe, route.path, vp.width, vp.height, {}, 3500);
        addCanvasPage(canvas, fullLabel);
        setProgress(Math.round((step / totalCaptures) * 100));
      }
    }

    // Per-platform credential input captures (desktop only). Loads the
    // Settings page ONCE with a cache-busting param, then expands each
    // connection platform sequentially and captures. The iframe doesn't
    // reload for same-URL navigations — reloading per-platform produced
    // blank captures for Neon, Turso, PlanetScale and everything after
    // the first credential capture.
    iframe.style.width = '1280px';
    iframe.style.height = '800px';
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      iframe.onload = () => setTimeout(finish, 2500);
      iframe.src = '/settings?_c=' + Date.now();
      setTimeout(finish, 28000);
    });
    // Wait for auth + data spinners to clear
    if (iframe.contentDocument) {
      const pollStart = Date.now();
      while (Date.now() - pollStart < 25000) {
        await new Promise(r => setTimeout(r, 400));
        if (!hasSpinner(iframe.contentDocument)) break;
      }
    }

    for (const p of PLATFORMS) {
      step++;
      const label = `Settings — ${p.label} (credential input)`;
      setStatus(`Capturing: ${label}`);
      try {
        const doc = iframe.contentDocument;
        const win = iframe.contentWindow;
        if (!doc || !win) continue;
        // Find the expand button for this platform by label text
        let targetBtn = null;
        for (const btn of doc.querySelectorAll('button')) {
          const span = btn.querySelector('span');
          if (span && span.textContent.trim() === p.label) { targetBtn = btn; break; }
        }
        if (!targetBtn) continue;
        targetBtn.click();
        await new Promise(r => setTimeout(r, 500));
        targetBtn.scrollIntoView({ block: 'start' });
        await new Promise(r => setTimeout(r, 300));
        const scrollY = win.scrollY;
        const captureHeight = Math.min(1200, Math.max(doc.body.scrollHeight - scrollY, 800));
        const canvas = await html2canvas(doc.body, {
          x: 0, y: scrollY,
          width: 1280, height: captureHeight,
          windowWidth: 1280, windowHeight: captureHeight,
          useCORS: true, backgroundColor: '#000000', scale: 1, logging: false,
        });
        addCanvasPage(canvas, label);
      } catch (e) { /* skip failed capture */ }
      setProgress(Math.round((step / totalCaptures) * 100));
    }

    document.body.removeChild(iframe);

    if (captured > 0) {
      // Try auto-download, but also provide a manual download button —
      // programmatic downloads are often blocked inside preview iframes.
      try { pdf.save('morpheus-screenshots.pdf'); } catch (e) { /* ignore */ }
      setPdfUrl(pdf.output('bloburl'));
      setStatus(`Done — ${captured} pages captured`);
    } else {
      setStatus('Capture failed — no pages generated');
    }
    setGenerating(false);
  };

  return (
    <div className="relative min-h-screen bg-background text-ink font-mono overflow-hidden">
      <MatrixRain opacity={0.04} />
      <div className="relative z-10 max-w-2xl mx-auto px-6 py-16 safe-top flex flex-col items-center justify-center min-h-screen text-center">
        <Link to="/" className="absolute top-4 left-4 flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider">
          <ArrowLeft size={14} /> BACK
        </Link>
        <Camera size={48} className="text-primary mb-4 neon-glow" />
        <h1 className="text-2xl font-display tracking-widest neon-glow mb-2 text-heading">SCREENSHOTS</h1>
        <p className="text-ink text-sm mb-8">// Live captures of every control UI screen. Generated on-demand from the running app — always current.</p>
        {generating && (
          <div className="w-full max-w-xs mb-6">
            <div className="flex items-center justify-between text-xs text-ink-strong mb-2">
              <span className="truncate">{status}</span>
              <span className="shrink-0 ml-2">{progress}%</span>
            </div>
            <div className="h-1 bg-primary/20 overflow-hidden">
              <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-[10px] text-ink-max mt-2">{pageCount} pages captured</p>
          </div>
        )}
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-2 px-6 py-3 bg-primary text-black hover:bg-[#39ff14] font-bold transition-colors shadow-[0_0_24px_-6px_rgba(0,255,65,0.5)] disabled:opacity-50"
        >
          {generating ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
          {generating ? 'GENERATING...' : 'GENERATE SCREENSHOTS PDF'}
        </button>
        {!generating && status && (
          <p className="text-ink-strong text-xs mt-4">{status}</p>
        )}
        {!generating && !status && (
          <p className="text-ink-strong text-xs mt-4">// Click to capture all UI screens and download as PDF</p>
        )}
        {pdfUrl && !generating && (
          <a
            href={pdfUrl}
            download="morpheus-screenshots.pdf"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 flex items-center gap-2 px-6 py-3 border border-primary text-primary hover:bg-primary hover:text-black font-bold transition-colors"
          >
            <Download size={18} /> DOWNLOAD PDF
          </a>
        )}
      </div>
    </div>
  );
}