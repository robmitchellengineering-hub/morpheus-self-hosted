import { useState, useRef } from 'react';
import { X, Bot, Square, Play, Loader2, Wrench, CheckCircle, AlertTriangle, MessageSquare, Timer } from 'lucide-react';
import DiagnosisPanel, { DiagnosisLoading } from '@/components/matrix/DiagnosisPanel';
import { useDiagnosis } from '@/hooks/useDiagnosis';
import { useRunTimer } from '@/hooks/useRunTimer';

export default function AutonomousPanel({ open, onClose, project, onStep, onSendToChat }) {
  const [spec, setSpec] = useState('');
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState([]);
  const [complete, setComplete] = useState(false);
  const stopRef = useRef(false);
  const startTimeRef = useRef(0);
  const { diagnosis, diagnosing, diagnose } = useDiagnosis();

  // ETA: dynamic from completed steps once the first one finishes, with a
  // 15-step baseline estimate before that. Total grows with progress so the
  // ETA stays finite for open-ended builds.
  const completedSteps = steps.filter(s => s.status === 'done' || s.status === 'error').length;
  const estimatedTotal = Math.max(15, completedSteps + 5);
  const { timerStr, etaStr } = useRunTimer({
    running,
    startTimeRef,
    progress: steps.length > 0 ? { completed: completedSteps, total: estimatedTotal } : null,
    estimateSeconds: 900,
  });

  const diagnoseStep = async (stepError, stepNum) => {
    await diagnose({
      type: 'build',
      projectId: project.id,
      errorContext: { error: stepError, step: stepNum, spec }
    });
  };

  const buildDiagnosisSpec = (diag) => {
    if (!diag) return null;
    const autoFixed = (diag.autoFixed || []).map(f => `- ${f.component}: ${f.fix} (${f.fileCount} file(s) updated)`).join('\n');
    const needsAction = (diag.needsUserAction || []).map(a => `- ${a.component}: ${a.issue}`).join('\n');
    return `The previous build step failed and was diagnosed.\n\nDiagnosis: ${diag.summary}\n\nAuto-fixed files:\n${autoFixed || '(none)'}\n\nStill needs your action:\n${needsAction || '(none)'}\n\nThe auto-fixes above have already been applied to the project files. Continue building the project — verify the fixed files are correct, then build the remaining files. Output only 2-3 files per step. Each file must be COMPLETE.`;
  };

  const handleStart = async (overrideSpec) => {
    setRunning(true);
    setComplete(false);
    stopRef.current = false;
    startTimeRef.current = Date.now();
    setSteps([]);

    let currentSpec = overrideSpec !== undefined ? overrideSpec : spec;
    const maxSteps = 50;
    let consecutiveCriticalSteps = 0;
    for (let i = 0; i < maxSteps; i++) {
      if (stopRef.current) break;

      setSteps(prev => [...prev, { step: i + 1, status: 'running', reply: 'Analyzing construct...' }]);

      try {
        const result = await onStep(currentSpec);
        // Hard reset — discard the in-flight result and break immediately
        if (stopRef.current) {
          setSteps(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = { ...updated[updated.length - 1], status: 'stopped', reply: 'Hard reset — stopped by operator.' };
            return updated;
          });
          break;
        }
        const reviewStatus = result?.reviewStatus;
        const criticalIssues = (reviewStatus?.issues || []).filter(iss => iss.severity === 'critical');

        // Output was truncated by token limit — don't stop, continue with smaller batch
        if (result?.truncated) {
          consecutiveCriticalSteps = 0;
          setSteps(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              step: i + 1,
              status: 'done',
              reply: result?.reply || 'Output truncated — reducing batch size.',
              fileOps: 0,
              isComplete: false,
              truncated: true,
              reviewApproved: reviewStatus?.approved,
              reviewIssues: reviewStatus?.issues || [],
              reviewSummary: reviewStatus?.summary
            };
            return updated;
          });
          currentSpec = 'Your last output was TRUNCATED by the token limit — the files arrived incomplete or broken. This step, output ONLY 2 small files (the most critical ones). Each file must be COMPLETE and self-contained. Never split a file across steps.';
          continue;
        }

        setSteps(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            step: i + 1,
            status: 'done',
            reply: result?.reply || '...',
            fileOps: result?.fileOperations?.length || 0,
            isComplete: result?.isComplete,
            reviewApproved: reviewStatus?.approved,
            reviewIssues: reviewStatus?.issues || [],
            reviewSummary: reviewStatus?.summary,
            outputMetrics: result?.outputMetrics
          };
          return updated;
        });

        // Stop only when the planner says complete AND the reviewer approves
        if (result?.isComplete && reviewStatus?.approved) {
          setComplete(true);
          break;
        }

        // Review found critical issues — feed them back to the coder for auto-fixing.
        // Only delegate to chat after 3 consecutive failed attempts (prevents infinite loops).
        if (criticalIssues.length > 0) {
          consecutiveCriticalSteps++;
          if (consecutiveCriticalSteps >= 3) {
            const issueList = criticalIssues.map(iss => `- ${iss.path}: ${iss.message}`).join('\n');
            const chatMsg = `The review agent found critical issues that couldn't be auto-fixed after ${consecutiveCriticalSteps} attempts:\n${issueList}\n\nFix it — let's get this code to compile.`;
            setSteps(prev => {
              const updated = [...prev];
              updated[updated.length - 1] = { ...updated[updated.length - 1], sentToChat: true };
              return updated;
            });
            onSendToChat?.(chatMsg);
            break;
          }
          const issueList = criticalIssues.map(iss => `- ${iss.path}: ${iss.message}`).join('\n');
          currentSpec = `The review agent found critical issues in the last build step:\n${issueList}\n\nFix these issues. Output the corrected files with FULL content. Each file must be COMPLETE.`;
          setSteps(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = { ...updated[updated.length - 1], autoFixing: true };
            return updated;
          });
          continue;
        }

        // No critical issues — reset counter and keep building
        consecutiveCriticalSteps = 0;
        if (!result?.isComplete) {
          continue;
        }
      } catch (e) {
        setSteps(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { step: i + 1, status: 'error', reply: e.message, autoFixing: true };
          return updated;
        });

        // Auto-diagnose the error and continue with the fix fed back
        if (i < maxSteps - 1 && !stopRef.current) {
          const diag = await diagnose({
            type: 'build',
            projectId: project.id,
            errorContext: { error: e.message, step: i + 1, spec: currentSpec }
          });
          if (diag) {
            const diagSpec = buildDiagnosisSpec(diag);
            currentSpec = diagSpec || `The previous build step failed: ${e.message}\n\nContinue building a complete, working project. Output only 2-3 files per step.`;
            setSteps(prev => {
              const updated = [...prev];
              updated[updated.length - 1] = { ...updated[updated.length - 1], autoFixing: false, diagnosis: diag };
              return updated;
            });
            continue;
          }
        }
        break;
      }
    }
    setRunning(false);
  };

  // Manual diagnose from an error step — feeds the diagnosis back and restarts
  const diagnoseAndRestart = async (stepError, stepNum) => {
    const diag = await diagnose({
      type: 'build',
      projectId: project.id,
      errorContext: { error: stepError, step: stepNum, spec }
    });
    if (diag) {
      const diagSpec = buildDiagnosisSpec(diag);
      handleStart(diagSpec);
    }
  };

  const handleStop = () => {
    stopRef.current = true;
    setRunning(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => !running && onClose()}>
      <div className="bg-background border border-primary/40 w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <Bot size={18} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">AUTONOMOUS MODE</span>
            {complete && <span className="text-xs text-primary border border-primary/40 px-2 py-0.5 neon-glow">COMPLETE</span>}
            {running && (
              <div className="flex items-center gap-2 text-primary font-mono text-xs ml-2">
                <span className="flex items-center gap-1"><Timer size={12} /> {timerStr}</span>
                {etaStr && <span className="text-primary/50">ETA {etaStr}</span>}
              </div>
            )}
          </div>
          <button onClick={() => !running && onClose()} disabled={running} className="text-primary/60 hover:text-primary disabled:opacity-30">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-3">
          {steps.length === 0 ? (
            <div>
              <p className="text-ink/60 text-sm mb-3">// Jack out. Let Morpheus build autonomously. Provide a spec or let him assess and complete the current construct.</p>
              <textarea
                value={spec}
                onChange={e => setSpec(e.target.value)}
                placeholder="Describe what to build, or leave blank to let Morpheus assess and complete the current state..."
                className="w-full h-32 bg-background border border-primary/30 text-primary p-3 text-sm outline-none focus:border-primary/60 resize-none scrollbar-matrix"
                disabled={running}
              />
            </div>
          ) : (
            steps.map((s, i) => (
              <div key={i} className="border border-primary/20 p-3">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-xs text-primary/50">STEP {s.step}</span>
                  {s.status === 'running' && <span className="text-xs text-primary animate-pulse">BUILDING...</span>}
                  {s.status === 'done' && <span className="text-xs text-ink/70">{s.fileOps} files modified</span>}
                  {s.outputMetrics?.coder?.totalTokens > 0 && (
                    <span className="text-xs text-ink/75">~{s.outputMetrics.coder.totalTokens} tok out</span>
                  )}
                  {s.outputMetrics?.coder?.usage?.completion_tokens && (
                    <span className="text-xs text-ink/75">{s.outputMetrics.coder.usage.completion_tokens} tok actual</span>
                  )}
                  {s.status === 'done' && s.reviewApproved && <span className="text-xs text-primary flex items-center gap-0.5"><CheckCircle size={10} /> REVIEW PASSED</span>}
                  {s.status === 'done' && s.reviewApproved === false && <span className="text-xs text-yellow-500 flex items-center gap-0.5"><AlertTriangle size={10} /> REVIEW FAILED — AUTO-FIXING</span>}
                  {s.truncated && <span className="text-xs text-yellow-500 flex items-center gap-0.5"><AlertTriangle size={10} /> OUTPUT TRUNCATED — REDUCING BATCH</span>}
                  {s.sentToChat && <span className="text-xs text-primary flex items-center gap-0.5"><MessageSquare size={10} /> SENT TO CHAT</span>}
                  {s.status === 'error' && <span className="text-xs text-red-500">ERROR</span>}
                  {s.status === 'stopped' && <span className="text-xs text-yellow-500">STOPPED</span>}
                  {s.autoFixing && <span className="text-xs text-yellow-500 animate-pulse flex items-center gap-0.5"><Wrench size={10} /> AUTO-DIAGNOSING...</span>}
                  {s.isComplete && s.reviewApproved && <span className="text-xs text-primary neon-glow">CONSTRUCT COMPLETE</span>}
                </div>
                <p className="text-ink/70 text-sm whitespace-pre-wrap">{s.reply}</p>
                {s.reviewIssues?.length > 0 && s.reviewApproved === false && (
                  <div className="mt-2 border border-yellow-500/30 bg-yellow-500/5 p-2 space-y-1">
                    {s.reviewIssues.filter(iss => iss.severity === 'critical').map((iss, j) => (
                      <div key={j} className="text-xs text-yellow-500/80 flex items-start gap-1">
                        <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                        <span className="font-mono">{iss.path}: {iss.message}</span>
                      </div>
                    ))}
                  </div>
                )}
                {s.status === 'error' && (
                  <div className="mt-2 space-y-2">
                    <button onClick={() => diagnoseAndRestart(s.reply, s.step)} disabled={diagnosing} className="flex items-center gap-1 text-xs text-primary hover:text-primary px-2 py-1 border border-primary/50 hover:border-primary disabled:opacity-30">
                      {diagnosing ? <Loader2 size={12} className="animate-spin" /> : <Bot size={12} />} AI DIAGNOSE & FIX
                    </button>
                    {diagnosing && <DiagnosisLoading label="AI AGENT ANALYZING BUILD STEP..." />}
                    {diagnosis && !diagnosing && <DiagnosisPanel diagnosis={diagnosis} onRedeploy={() => handleStart(buildDiagnosisSpec(diagnosis))} redeployLabel="RESTART BUILD" />}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="px-4 py-3 border-t border-primary/20 flex justify-end gap-2 shrink-0">
          {running ? (
            <button onClick={handleStop} className="flex items-center gap-1 text-xs text-black bg-red-500 hover:bg-red-400 px-4 py-2 font-bold">
              <Square size={14} /> HARD STOP
            </button>
          ) : (
            <button onClick={() => handleStart()} className="flex items-center gap-1 text-xs text-black bg-primary hover:bg-[#39ff14] px-4 py-2 font-bold">
              <Play size={14} /> {steps.length > 0 ? 'RESTART' : 'JACK OUT'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}