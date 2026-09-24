import { useState } from 'react';
import { Network, Loader2, Download, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import jsPDF from 'jspdf';
import MatrixRain from '@/components/matrix/MatrixRain';
import { OPERATIONS, SHARED_MODULES, WORKFLOWS, ENTITIES, SDK_INFO } from '@/lib/flowDiagramData';

const NEON = [0, 255, 65];
const DIM = [0, 180, 50];

export default function FlowDiagram() {
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [pdfUrl, setPdfUrl] = useState(null);

  const handleGenerate = async () => {
    setGenerating(true);
    setProgress(0);
    if (pdfUrl) { URL.revokeObjectURL(pdfUrl); setPdfUrl(null); }

    const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 32;
    let y = margin;

    // Paint every page black before drawing (jsPDF defaults to white).
    const paintBlack = () => {
      pdf.setFillColor(0, 0, 0);
      pdf.rect(0, 0, pageW, pageH, 'F');
    };
    paintBlack();

    const addPageIfNeeded = (needed) => {
      if (y + needed > pageH - margin) { pdf.addPage(); paintBlack(); y = margin; }
    };
    const header = (text, size = 14) => {
      addPageIfNeeded(size + 12);
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(size);
      pdf.setTextColor(...NEON);
      pdf.text(text, margin, y);
      y += size + 4;
      pdf.setDrawColor(...DIM); pdf.setLineWidth(0.5);
      pdf.line(margin, y, pageW - margin, y);
      y += 10;
    };
    const body = (text, size = 8, color = NEON, bold = false) => {
      pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(size);
      pdf.setTextColor(...color);
      const lines = pdf.splitTextToSize(text, pageW - margin * 2);
      for (const line of lines) {
        addPageIfNeeded(size + 2);
        pdf.text(line, margin, y);
        y += size + 2;
      }
    };
    const drawBox = (x, y, w, h, label, fill = false) => {
      pdf.setDrawColor(...NEON); pdf.setLineWidth(1);
      if (fill) { pdf.setFillColor(0, 30, 10); pdf.rect(x, y, w, h, 'FD'); }
      else pdf.rect(x, y, w, h, 'S');
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7);
      pdf.setTextColor(...NEON);
      const lines = pdf.splitTextToSize(label, w - 6);
      pdf.text(lines, x + 3, y + 9);
    };
    const drawArrow = (x1, y1, x2, y2) => {
      pdf.setDrawColor(...DIM); pdf.setLineWidth(0.5);
      pdf.line(x1, y1, x2, y2);
      // arrowhead
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const ah = 5;
      pdf.line(x2, y2, x2 - ah * Math.cos(angle - 0.4), y2 - ah * Math.sin(angle - 0.4));
      pdf.line(x2, y2, x2 - ah * Math.cos(angle + 0.4), y2 - ah * Math.sin(angle + 0.4));
    };

    // ── Title Page ──
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(28);
    pdf.setTextColor(...NEON);
    pdf.text('MORPHEUS', pageW / 2, pageH / 2 - 40, { align: 'center' });
    pdf.setFontSize(16);
    pdf.text('OPERATIONS FLOW DIAGRAM', pageW / 2, pageH / 2 - 10, { align: 'center' });
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    pdf.setTextColor(...DIM);
    pdf.text('Complete call graph of every backend function, shared module, and workflow', pageW / 2, pageH / 2 + 15, { align: 'center' });
    pdf.text(`Generated: ${new Date().toISOString()}`, pageW / 2, pageH / 2 + 30, { align: 'center' });
    pdf.text(`SDK: ${SDK_INFO.sdk}  |  Runtime: ${SDK_INFO.runtime}`, pageW / 2, pageH / 2 + 45, { align: 'center' });
    pdf.text(`AI: ${SDK_INFO.aiProvider}`, pageW / 2, pageH / 2 + 58, { align: 'center' });
    pdf.text(`GitHub: ${SDK_INFO.githubConnector}`, pageW / 2, pageH / 2 + 71, { align: 'center' });
    pdf.text(`Stripe: ${SDK_INFO.stripeMode}`, pageW / 2, pageH / 2 + 84, { align: 'center' });
    setProgress(5);

    // ── Architecture Overview ──
    pdf.addPage(); paintBlack(); y = margin;
    header('ARCHITECTURE OVERVIEW');
    body('Morpheus is an AI-assisted development platform with a multi-phase AI pipeline (Planner → Coder → Reviewer),', 9);
    body('native compilation via GitHub Actions, multi-target backend deployment, a template marketplace with Stripe payments,', 9);
    body('and a unified diagnosis agent that auto-fixes errors. All operations run as Base44 backend functions (Deno runtime).', 9);
    y += 6;
    body('LAYERS:', 9, NEON, true);
    body('  1. Frontend (React) — ChatPanel, Workspace, Architect, Market, Settings, CompilePanel, etc.', 8);
    body('  2. Backend Functions (35 functions) — AI build, compile, deploy, GitHub, marketplace, diagnosis, utilities', 8);
    body('  3. Shared Modules (15 modules) — aiUtils, reviewer, githubPush, infrastructureComponents, stripeUtils, etc.', 8);
    body('  4. Entities (11) — Project, ProjectFile, ChatMessage, FileSnapshot, UsageRecord, Template, Purchase, etc.', 8);
    body('  5. External Services — GitHub API, Stripe API, Cloudflare/Vercel/Netlify/Railway/Render/Fly, Supabase, AI providers', 8);
    y += 6;
    body('AI PIPELINE (used by chat, autonomous, backend, tests, diagnosis):', 9, NEON, true);
    body('  invokeAI(role) → [Planner reasons] → [Coder implements] → [Reviewer checks] → [Retry if critical] → [Commit]', 8);
    body('  Custom endpoint: OpenAI-compatible (OpenRouter, Together, Groq, Ollama, LM Studio) with role-specific model overrides', 8);
    body('  Platform default: base44.asServiceRole.integrations.Core.InvokeLLM with model override support', 8);
    setProgress(10);

    // ── Workflows (visual flow diagrams) ──
    for (let i = 0; i < WORKFLOWS.length; i++) {
      const wf = WORKFLOWS[i];
      pdf.addPage(); paintBlack(); y = margin;
      header(`WORKFLOW: ${wf.name.toUpperCase()}`);
      body(`Trigger: ${wf.trigger}`, 8, DIM);
      y += 4;

      // Draw vertical flow diagram
      const boxW = pageW - margin * 2;
      const stepH = 16;
      const stepGap = 6;
      for (let s = 0; s < wf.steps.length; s++) {
        const step = wf.steps[s];
        addPageIfNeeded(stepH + stepGap + 8);
        const boxY = y;
        // Actor label (left, bold)
        drawBox(margin, boxY, Math.min(180, boxW * 0.3), stepH, step.actor);
        // Action (right)
        pdf.setDrawColor(...DIM); pdf.setLineWidth(0.5);
        pdf.rect(margin + Math.min(184, boxW * 0.3 + 4), boxY, boxW - Math.min(184, boxW * 0.3 + 4), stepH, 'S');
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.5);
        pdf.setTextColor(...NEON);
        const actionLines = pdf.splitTextToSize(step.action, boxW - Math.min(188, boxW * 0.3 + 8) - 6);
        pdf.text(actionLines, margin + Math.min(188, boxW * 0.3 + 8), boxY + 8);
        // Arrow to next step
        if (s < wf.steps.length - 1) {
          const arrowX = margin + Math.min(90, boxW * 0.15);
          drawArrow(arrowX, boxY + stepH, arrowX, boxY + stepH + stepGap);
        }
        y += stepH + stepGap;
      }
      setProgress(10 + Math.round(((i + 1) / WORKFLOWS.length) * 35));
    }

    // ── Operations (detailed call info) ──
    const categories = [...new Set(OPERATIONS.map(o => o.category))];
    let catProgress = 45;
    for (const cat of categories) {
      pdf.addPage(); paintBlack(); y = margin;
      header(`OPERATIONS: ${cat.toUpperCase()}`);
      const ops = OPERATIONS.filter(o => o.category === cat);
      for (const op of ops) {
        addPageIfNeeded(60);
        body(`▸ ${op.name}`, 10, NEON, true);
        body(`  Purpose: ${op.purpose}`, 8);
        body(`  Inputs: ${op.inputs.join(', ')}`, 8, DIM);
        body(`  Outputs: ${op.outputs.join(', ')}`, 8, DIM);
        body('  Calls:', 8, NEON, true);
        for (const call of op.calls) {
          body(`    → ${call}`, 7);
        }
        if (op.entities?.length) body(`  Entities: ${op.entities.join(', ')}`, 7, DIM);
        if (op.sharedModules?.length) body(`  Shared: ${op.sharedModules.join(', ')}`, 7, DIM);
        if (op.externalServices?.length) body(`  External: ${op.externalServices.join(', ')}`, 7, DIM);
        y += 4;
      }
      catProgress += Math.round(40 / categories.length);
      setProgress(catProgress);
    }

    // ── Shared Modules ──
    pdf.addPage(); paintBlack(); y = margin;
    header('SHARED MODULES');
    for (const mod of SHARED_MODULES) {
      addPageIfNeeded(50);
      body(`▸ ${mod.name}`, 10, NEON, true);
      body(`  Purpose: ${mod.purpose}`, 8);
      body(`  Exports: ${mod.exports.join(', ')}`, 7, DIM);
      body(`  Details: ${mod.details}`, 7);
      body(`  Used by: ${mod.usedBy.join(', ')}`, 7, DIM);
      y += 4;
    }
    setProgress(90);

    // ── Entities ──
    pdf.addPage(); paintBlack(); y = margin;
    header('DATA ENTITIES');
    for (const ent of ENTITIES) {
      addPageIfNeeded(16);
      body(`▸ ${ent.name}`, 9, NEON, true);
      body(`  ${ent.purpose}`, 8);
      y += 2;
    }
    setProgress(95);

    // ── Call Graph Summary ──
    pdf.addPage(); paintBlack(); y = margin;
    header('CALL GRAPH SUMMARY');
    body('Most-called shared modules:', 9, NEON, true);
    const moduleUsage = {};
    SHARED_MODULES.forEach(m => { moduleUsage[m.name] = m.usedBy.length; });
    Object.entries(moduleUsage).sort((a, b) => b[1] - a[1]).forEach(([name, count]) => {
      body(`  ${name}: used by ${count} function(s)`, 8);
    });
    y += 6;
    body('External service dependencies:', 9, NEON, true);
    const services = new Set();
    OPERATIONS.forEach(o => o.externalServices?.forEach(s => services.add(s)));
    [...services].sort().forEach(s => body(`  → ${s}`, 8));
    y += 6;
    body(`Total: ${OPERATIONS.length} backend functions, ${SHARED_MODULES.length} shared modules, ${WORKFLOWS.length} workflows, ${ENTITIES.length} entities`, 9, NEON, true);
    setProgress(100);

    // ── Output ──
    try { pdf.save('morpheus-flow-diagram.pdf'); } catch {}
    setPdfUrl(pdf.output('bloburl'));
    setStatus(`Done — ${pdf.getNumberOfPages()} pages generated`);
    setGenerating(false);
  };

  return (
    <div className="relative min-h-screen bg-background text-ink font-mono overflow-hidden">
      <MatrixRain opacity={0.04} />
      <div className="relative z-10 max-w-2xl mx-auto px-6 py-16 safe-top flex flex-col items-center justify-center min-h-screen text-center">
        <Link to="/" className="absolute top-4 left-4 flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider">
          <ArrowLeft size={14} /> BACK
        </Link>
        <Network size={48} className="text-primary mb-4 neon-glow" />
        <h1 className="text-2xl font-display tracking-widest neon-glow mb-2 text-heading">FLOW DIAGRAM</h1>
        {/* Stale-document disclaimer. The page claimed it was "Generated live from the
             source code model"; it is rendered from a hand-written data literal that
             still describes the pre-rewrite Base44 stack (35 backend functions, 15
             shared modules, 11 entities, a Deno runtime — against 123, 79, 54 and
             Node/Express today). Correcting the claim is the honest minimum; the page
             is parked for a real fix or removal. */}
        <p className="text-ink text-sm mb-8">// This is a point-in-time snapshot of an EARLIER architecture. It is not generated from the current source and has not been maintained: parts of it describe the pre-rewrite Base44 stack (a Deno runtime, the @base44/sdk, model names that do not exist here) and are simply wrong. For what the system actually is, run `node scripts/context.mjs`.</p>
        {generating && (
          <div className="w-full max-w-xs mb-6">
            <div className="flex items-center justify-between text-xs text-ink-strong mb-2">
              <span className="truncate">{status}</span>
              <span className="shrink-0 ml-2">{progress}%</span>
            </div>
            <div className="h-1 bg-primary/20 overflow-hidden">
              <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-2 px-6 py-3 bg-primary text-black hover:bg-[#39ff14] font-bold transition-colors shadow-[0_0_24px_-6px_rgba(0,255,65,0.5)] disabled:opacity-50"
        >
          {generating ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
          {generating ? 'GENERATING...' : 'GENERATE FLOW DIAGRAM PDF'}
        </button>
        {!generating && status && <p className="text-ink-strong text-xs mt-4">{status}</p>}
        {!generating && !status && <p className="text-ink-strong text-xs mt-4">// Click to generate the complete operations flow diagram as PDF</p>}
        {pdfUrl && !generating && (
          <a href={pdfUrl} download="morpheus-flow-diagram.pdf" target="_blank" rel="noopener noreferrer"
            className="mt-4 flex items-center gap-2 px-6 py-3 border border-primary text-primary hover:bg-primary hover:text-black font-bold transition-colors">
            <Download size={18} /> DOWNLOAD PDF
          </a>
        )}
      </div>
    </div>
  );
}