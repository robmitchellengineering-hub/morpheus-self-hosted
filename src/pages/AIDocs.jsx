import { useState } from 'react';
import { Brain, Loader2, Download, ArrowLeft, Cpu, Zap, ShieldCheck, Stethoscope, Network } from 'lucide-react';
import { Link } from 'react-router-dom';
import jsPDF from 'jspdf';
import MatrixRain from '@/components/matrix/MatrixRain';
import { AI_SETTINGS, AI_FUNCTIONS, AI_SHARED_MODULES, AI_WORKFLOWS, AI_PIPELINE_SUMMARY } from '@/lib/aiFunctionsData';

const NEON = [0, 255, 65];
const DIM = [0, 180, 50];
const WHITE = [200, 220, 210];

const ROLE_ICONS = { planner: Brain, coder: Zap, reviewer: ShieldCheck, diagnosis: Stethoscope };

export default function AIDocs() {
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
    const drawArrow = (x1, y1, x2, y2) => {
      pdf.setDrawColor(...DIM); pdf.setLineWidth(0.5);
      pdf.line(x1, y1, x2, y2);
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
    pdf.text('AI FUNCTIONS & SETTINGS REFERENCE', pageW / 2, pageH / 2 - 10, { align: 'center' });
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    pdf.setTextColor(...DIM);
    pdf.text('Every AI function, system prompt, model role, JSON schema, and workflow', pageW / 2, pageH / 2 + 15, { align: 'center' });
    pdf.text(`Generated: ${new Date().toISOString()}`, pageW / 2, pageH / 2 + 30, { align: 'center' });
    pdf.text(`Functions: ${AI_FUNCTIONS.length}  |  Shared Modules: ${AI_SHARED_MODULES.length}  |  Workflows: ${AI_WORKFLOWS.length}`, pageW / 2, pageH / 2 + 45, { align: 'center' });
    pdf.text(`Pipeline Phases: ${AI_PIPELINE_SUMMARY.phases.length}  |  Model Roles: planner, coder, reviewer, diagnosis`, pageW / 2, pageH / 2 + 58, { align: 'center' });
    setProgress(5);

    // ── AI Settings ──
    pdf.addPage(); paintBlack(); y = margin;
    header('AI SETTINGS CONFIGURATION');
    body('Two modes: Default (platform InvokeLLM) or Custom (OpenAI-compatible endpoint).', 9);
    body('Per-role model overrides let you pair a high-think planner with a fast coder.', 9);
    y += 4;

    body('MODES:', 9, NEON, true);
    for (const mode of AI_SETTINGS.modes) {
      body(`  ${mode.value}: ${mode.label}`, 8);
      body(`    ${mode.description}`, 7, DIM);
    }
    y += 4;

    body('CUSTOM ENDPOINT FIELDS (UserSettings entity):', 9, NEON, true);
    for (const f of AI_SETTINGS.customFields) {
      body(`  ${f.key}: ${f.label} — ${f.description}`, 8);
    }
    y += 4;

    body('ROLE-SPECIFIC MODEL OVERRIDES:', 9, NEON, true);
    for (const role of AI_SETTINGS.roles) {
      body(`  ${role.label} (${role.key}):`, 8, NEON, true);
      body(`    ${role.description}`, 7, WHITE);
      body(`    Default tier: ${role.tier}`, 7, DIM);
    }
    y += 4;

    body('AVAILABLE MODELS:', 9, NEON, true);
    for (const m of AI_SETTINGS.models) {
      body(`  ${m.value || '(empty)'}: ${m.label}`, 7, m.tier === 'high' ? NEON : m.tier === 'fast' ? DIM : WHITE);
    }
    y += 4;

    body('INVOKE PARAMETERS:', 9, NEON, true);
    body(`  Platform: ${AI_SETTINGS.invokeParams.platform}`, 7, WHITE);
    body(`  Custom: ${AI_SETTINGS.invokeParams.custom}`, 7, WHITE);
    body(`  Temperature: ${AI_SETTINGS.invokeParams.temperature}`, 7, DIM);
    body(`  Max tokens: ${AI_SETTINGS.invokeParams.maxTokens}`, 7, DIM);
    body(`  Truncation: ${AI_SETTINGS.invokeParams.truncationDetection}`, 7, DIM);
    body(`  Vision: ${AI_SETTINGS.invokeParams.vision}`, 7, DIM);
    setProgress(15);

    // ── Pipeline Summary ──
    pdf.addPage(); paintBlack(); y = margin;
    header('AI PIPELINE — PLANNER → CODER → REVIEWER');
    body(`Routing: ${AI_PIPELINE_SUMMARY.routing}`, 8, WHITE);
    y += 4;

    body('PHASES:', 9, NEON, true);
    const phaseH = 20;
    const phaseGap = 6;
    for (let i = 0; i < AI_PIPELINE_SUMMARY.phases.length; i++) {
      const phase = AI_PIPELINE_SUMMARY.phases[i];
      addPageIfNeeded(phaseH + phaseGap + 8);
      const boxY = y;
      pdf.setDrawColor(...NEON); pdf.setLineWidth(1);
      pdf.setFillColor(0, 30, 10);
      pdf.rect(margin, boxY, 120, phaseH, 'FD');
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8);
      pdf.setTextColor(...NEON);
      pdf.text(phase.name.toUpperCase(), margin + 6, boxY + 8);
      pdf.setFontSize(6); pdf.setTextColor(...DIM);
      pdf.text(`role: ${phase.role}`, margin + 6, boxY + 16);

      pdf.setDrawColor(...DIM); pdf.setLineWidth(0.5);
      pdf.rect(margin + 126, boxY, pageW - margin * 2 - 126, phaseH, 'S');
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7);
      pdf.setTextColor(...WHITE);
      const descLines = pdf.splitTextToSize(phase.description, pageW - margin * 2 - 132);
      pdf.text(descLines, margin + 130, boxY + 8);

      if (i < AI_PIPELINE_SUMMARY.phases.length - 1) {
        drawArrow(margin + 60, boxY + phaseH, margin + 60, boxY + phaseH + phaseGap);
      }
      y += phaseH + phaseGap;
    }
    y += 4;

    body('GUARANTEES:', 9, NEON, true);
    for (const g of AI_PIPELINE_SUMMARY.guarantees) {
      body(`  ✓ ${g}`, 7, WHITE);
    }
    setProgress(25);

    // ── Workflows ──
    for (let i = 0; i < AI_WORKFLOWS.length; i++) {
      const wf = AI_WORKFLOWS[i];
      pdf.addPage(); paintBlack(); y = margin;
      header(`WORKFLOW: ${wf.name.toUpperCase()}`);
      body(`Trigger: ${wf.trigger}`, 8, DIM);
      y += 4;

      const boxW = pageW - margin * 2;
      const stepH = 16;
      const stepGap = 6;
      for (let s = 0; s < wf.steps.length; s++) {
        const step = wf.steps[s];
        addPageIfNeeded(stepH + stepGap + 8);
        const boxY = y;
        const actorW = Math.min(180, boxW * 0.3);
        // Actor box
        pdf.setDrawColor(...NEON); pdf.setLineWidth(1);
        pdf.setFillColor(0, 30, 10);
        pdf.rect(margin, boxY, actorW, stepH, 'FD');
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7);
        pdf.setTextColor(...NEON);
        const actorLines = pdf.splitTextToSize(step.actor, actorW - 6);
        pdf.text(actorLines, margin + 3, boxY + 8);
        // Action box
        const actionX = margin + actorW + 4;
        const actionW = boxW - actorW - 4;
        pdf.setDrawColor(...DIM); pdf.setLineWidth(0.5);
        pdf.rect(actionX, boxY, actionW, stepH, 'S');
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.5);
        pdf.setTextColor(...WHITE);
        const actionLines = pdf.splitTextToSize(step.action, actionW - 6);
        pdf.text(actionLines, actionX + 3, boxY + 8);
        // Arrow
        if (s < wf.steps.length - 1) {
          const arrowX = margin + Math.min(90, boxW * 0.15);
          drawArrow(arrowX, boxY + stepH, arrowX, boxY + stepH + stepGap);
        }
        y += stepH + stepGap;
      }
      setProgress(25 + Math.round(((i + 1) / AI_WORKFLOWS.length) * 25));
    }

    // ── AI Functions (detailed) ──
    const categories = [...new Set(AI_FUNCTIONS.map(f => f.category))];
    let fnProgress = 50;
    for (const cat of categories) {
      pdf.addPage(); paintBlack(); y = margin;
      header(`FUNCTIONS: ${cat.toUpperCase()}`);
      const funcs = AI_FUNCTIONS.filter(f => f.category === cat);
      for (const fn of funcs) {
        addPageIfNeeded(80);
        body(`▸ ${fn.name}`, 11, NEON, true);
        body(`  Purpose: ${fn.purpose}`, 8, WHITE);
        body(`  Inputs: ${fn.inputs.join(', ')}`, 7, DIM);
        body(`  Outputs: ${fn.outputs.join(', ')}`, 7, DIM);
        if (fn.roles.length > 0) {
          body(`  AI Roles: ${fn.roles.map(r => `${r} (${AI_SETTINGS.roles.find(s => s.key.replace('_model', '') === r)?.label || r})`).join(', ')}`, 7, NEON);
        } else {
          body(`  AI Roles: none (no LLM call)`, 7, DIM);
        }
        body(`  Prompt: ${fn.promptName}`, 7, DIM);
        body(`  Prompt Summary:`, 7, NEON, true);
        body(`    ${fn.promptSummary}`, 7, WHITE);
        y += 2;
        body(`  Workflow:`, 7, NEON, true);
        for (const step of fn.workflow) {
          body(`    ${step}`, 6, WHITE);
        }
        y += 2;
        if (fn.jsonSchemas?.length) {
          body(`  JSON Schemas:`, 7, NEON, true);
          for (const schema of fn.jsonSchemas) {
            body(`    ${schema.name}: { ${schema.fields.join(', ')} }`, 6, WHITE);
          }
        }
        if (fn.errorTypes?.length) {
          body(`  Error Types:`, 7, NEON, true);
          for (const et of fn.errorTypes) {
            body(`    ${et.type}: ${et.description}`, 6, WHITE);
          }
        }
        y += 6;
      }
      fnProgress += Math.round(35 / categories.length);
      setProgress(fnProgress);
    }

    // ── Shared AI Modules ──
    pdf.addPage(); paintBlack(); y = margin;
    header('SHARED AI MODULES');
    for (const mod of AI_SHARED_MODULES) {
      addPageIfNeeded(60);
      body(`▸ ${mod.name}`, 10, NEON, true);
      body(`  Purpose: ${mod.purpose}`, 8, WHITE);
      body(`  Exports: ${mod.exports.join(', ')}`, 7, DIM);
      body(`  Key logic:`, 7, NEON, true);
      for (const logic of mod.keyLogic) {
        body(`    • ${logic}`, 6, WHITE);
      }
      body(`  Used by: ${mod.usedBy.join(', ')}`, 7, DIM);
      y += 4;
    }
    setProgress(90);

    // ── Quick Reference ──
    pdf.addPage(); paintBlack(); y = margin;
    header('QUICK REFERENCE — FUNCTION → ROLE → MODEL TIER');
    const tierColors = { fast: DIM, balanced: WHITE, high: NEON, auto: DIM };
    for (const fn of AI_FUNCTIONS) {
      addPageIfNeeded(14);
      const tierLabel = fn.roles.length > 0
        ? fn.roles.map(r => AI_SETTINGS.roles.find(s => s.key.replace('_model', '') === r)?.tier || 'auto').join('/')
        : 'none';
      body(`${fn.name.padEnd(28)} roles: ${(fn.roles.join(', ') || 'none').padEnd(20)} tier: ${tierLabel}`, 7, WHITE);
    }
    y += 6;
    body('MODEL TIER GUIDE:', 9, NEON, true);
    body('  fast = GPT 5 Mini, Gemini 3 Flash — lowest cost, used for coding', 7, DIM);
    body('  balanced = GPT 5.4/5.6, Claude Sonnet — medium cost, used for review', 7, WHITE);
    body('  high = Claude Opus, Gemini Pro — highest cost, used for planning/diagnosis', 7, NEON);
    body('  auto = platform default (no override) — lowest credit cost', 7, DIM);
    y += 6;
    body(`Total: ${AI_FUNCTIONS.length} AI functions across ${categories.length} categories, ${AI_SHARED_MODULES.length} shared modules, ${AI_WORKFLOWS.length} workflows`, 9, NEON, true);
    setProgress(100);

    // ── Output ──
    try { pdf.save('morpheus-ai-functions.pdf'); } catch {}
    setPdfUrl(pdf.output('bloburl'));
    setStatus(`Done — ${pdf.getNumberOfPages()} pages generated`);
    setGenerating(false);
  };

  return (
    <div className="relative min-h-screen bg-black text-primary font-mono overflow-hidden">
      <MatrixRain opacity={0.04} />
      <div className="relative z-10 max-w-2xl mx-auto px-6 py-16 safe-top flex flex-col items-center justify-center min-h-screen text-center">
        <Link to="/" className="absolute top-4 left-4 flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider">
          <ArrowLeft size={14} /> BACK
        </Link>
        <div className="flex items-center gap-3 mb-4">
          <Cpu size={48} className="text-primary neon-glow" />
        </div>
        <h1 className="text-2xl font-display tracking-widest neon-glow mb-2">AI FUNCTIONS &amp; SETTINGS</h1>
        <p className="text-primary/60 text-sm mb-8">// Every AI function Morpheus uses — system prompts, model roles, JSON schemas, and workflows. The exact AI settings and commands used to generate each function and how they work. Generated live from the source code.</p>

        {/* On-screen summary */}
        <div className="w-full max-w-md text-left mb-8 space-y-3">
          <div className="border border-primary/30 bg-black/60 p-3">
            <p className="text-[10px] text-primary/50 tracking-[0.2em] font-display mb-2">// PIPELINE PHASES</p>
            <div className="grid grid-cols-2 gap-2">
              {AI_PIPELINE_SUMMARY.phases.map(p => {
                const Icon = ROLE_ICONS[p.role] || Brain;
                return (
                  <div key={p.name} className="flex items-center gap-1.5 text-xs">
                    <Icon size={12} className="text-primary" />
                    <span className="text-primary">{p.name}</span>
                    <span className="text-primary/40">({p.role})</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="border border-primary/30 bg-black/60 p-3">
            <p className="text-[10px] text-primary/50 tracking-[0.2em] font-display mb-2">// FUNCTIONS BY CATEGORY</p>
            {[...new Set(AI_FUNCTIONS.map(f => f.category))].map(cat => (
              <div key={cat} className="text-xs mb-1">
                <span className="text-primary/70">{cat}:</span>{' '}
                <span className="text-primary/50">{AI_FUNCTIONS.filter(f => f.category === cat).map(f => f.name).join(', ')}</span>
              </div>
            ))}
          </div>
          <div className="border border-primary/30 bg-black/60 p-3">
            <p className="text-[10px] text-primary/50 tracking-[0.2em] font-display mb-2">// MODEL TIERS</p>
            <div className="text-xs space-y-1">
              <div><span className="text-primary">fast</span> <span className="text-primary/50">— GPT 5 Mini, Gemini Flash (coder)</span></div>
              <div><span className="text-primary">balanced</span> <span className="text-primary/50">— GPT 5.4/5.6, Sonnet (reviewer)</span></div>
              <div><span className="text-primary">high</span> <span className="text-primary/50">— Opus, Gemini Pro (planner, diagnosis)</span></div>
            </div>
          </div>
        </div>

        {generating && (
          <div className="w-full max-w-xs mb-6">
            <div className="flex items-center justify-between text-xs text-primary/70 mb-2">
              <span className="truncate">{status || 'Generating...'}</span>
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
          {generating ? 'GENERATING...' : 'GENERATE AI DOCS PDF'}
        </button>
        {!generating && status && <p className="text-primary/40 text-xs mt-4">{status}</p>}
        {!generating && !status && <p className="text-primary/40 text-xs mt-4">// Click to generate the complete AI functions & settings reference as PDF</p>}
        {pdfUrl && !generating && (
          <a href={pdfUrl} download="morpheus-ai-functions.pdf" target="_blank" rel="noopener noreferrer"
            className="mt-4 flex items-center gap-2 px-6 py-3 border border-primary text-primary hover:bg-primary hover:text-black font-bold transition-colors">
            <Download size={18} /> DOWNLOAD PDF
          </a>
        )}
      </div>
    </div>
  );
}