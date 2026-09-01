import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Loader2, CheckCircle, ArrowLeft, Download } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import MatrixRain from '@/components/matrix/MatrixRain';

// New — not a base44 port, but modeled on base44's live admin-only
// "MORPHEUS UPDATES PLAN" tool. Mirrors RebuildBlueprint.jsx's
// load-existing / SYNTHESIZE-to-regenerate pattern. Backed by
// server/src/functions/synthesizeUpdatesPlan.js, which reads every
// Feedback row submitted via the landing page's "SUGGEST AN IMPROVEMENT"
// box and asks the LLM to rank them into this plan.
export default function UpdatesPlan() {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [error, setError] = useState(null);

  const loadPlan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await base44.entities.UpdatesPlan.list('-created_date', 1);
      setPlan(list.length > 0 ? list[0] : null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPlan(); }, [loadPlan]);

  const synthesize = async () => {
    setSynthesizing(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('synthesizeUpdatesPlan', {});
      if (res.data) {
        setPlan({ content: res.data.content, feedback_count: res.data.feedbackCount, updated_date: new Date().toISOString() });
      } else {
        await loadPlan();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSynthesizing(false);
    }
  };

  const downloadMd = () => {
    if (!plan) return;
    const blob = new Blob([plan.content || ''], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'morpheus-updates-plan.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="relative min-h-screen bg-background text-primary font-mono">
      <MatrixRain opacity={0.04} />
      <div className="relative z-10 max-w-3xl mx-auto px-6 py-12 safe-top">
        <Link to="/" className="inline-flex items-center gap-1.5 text-primary/60 hover:text-primary text-sm mb-6 transition-colors">
          <ArrowLeft size={14} /> BACK
        </Link>

        <div className="flex items-center gap-3 mb-2">
          <Sparkles size={24} className="text-primary neon-glow" />
          <h1 className="text-2xl md:text-3xl font-display tracking-widest neon-glow text-heading">MORPHEUS UPDATES PLAN</h1>
        </div>
        <p className="text-primary/60 text-sm mb-8">
          // Synthesizes every user-submitted issue and feature request into a single prioritized, actionable plan — ranked by criticality, alignment with build strategy and model ethos, and revenue potential.
        </p>

        {loading && (
          <div className="flex items-center gap-2 text-primary/60 text-sm py-12 justify-center">
            <Loader2 size={16} className="animate-spin" /> Loading plan...
          </div>
        )}

        {error && (
          <div className="text-red-500 text-sm border border-red-500/30 px-3 py-2 mb-4">{error}</div>
        )}

        {!loading && plan && (
          <div className="space-y-4 mb-6">
            <div className="flex items-center gap-2 text-xs text-primary/60">
              <CheckCircle size={14} className="text-primary" />
              Last synthesized: <span className="text-primary">{new Date(plan.updated_date || plan.created_date).toLocaleString()}</span>
              <span className="text-primary/65">|</span>
              {plan.feedback_count ?? 0} feedback item{plan.feedback_count === 1 ? '' : 's'}
            </div>
            <div className="border border-primary/20 bg-primary/5 p-4 max-h-[32rem] overflow-y-auto scrollbar-matrix text-xs text-primary/70 font-mono whitespace-pre-wrap">
              {plan.content}
            </div>
          </div>
        )}

        {!loading && !plan && !error && (
          <p className="text-primary/75 text-sm italic text-center py-12">No plan synthesized yet. Press SYNTHESIZE PLAN to generate one from submitted feedback.</p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={synthesize}
            disabled={synthesizing}
            className="flex items-center gap-2 px-5 py-2.5 border border-primary text-primary hover:bg-primary hover:text-black transition-colors font-bold text-sm disabled:opacity-50"
          >
            {synthesizing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {plan ? 'RE-SYNTHESIZE PLAN' : 'SYNTHESIZE PLAN'}
          </button>
          <button
            onClick={downloadMd}
            disabled={!plan}
            className="flex items-center gap-2 px-5 py-2.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary transition-colors text-sm disabled:opacity-30"
          >
            <Download size={14} /> DOWNLOAD .MD
          </button>
        </div>
      </div>
    </div>
  );
}
