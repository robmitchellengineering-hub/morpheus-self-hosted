import { useState, useEffect, useRef } from 'react';
import { Bot, CheckCircle, Wrench, ArrowRight, AlertTriangle, Key, ExternalLink, Link as LinkIcon, MessageSquare, Timer } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatRunTime } from '@/hooks/useRunTimer';

// Shared diagnosis results panel — renders the unified diagnosis shape returned
// by the diagnoseIssue backend function. Used across deploy, compile, github, and
// build flows for consistent Morpheus-wide AI assistance.

// 2026-09-04 (Rob: "i need an eta timer and larger spinning circle with steps
// in the compile ai fix window, its hard to tell its doing anything") — the
// diagnose call is a single opaque network request with no real progress
// events, so there's no true step-by-step data to show (unlike the polling
// phase, which gets real step counts from GitHub Actions). Rather than show
// nothing, these steps advance on an elapsed-time heuristic — same spirit as
// MorpheusPipelineStatus's chat-pipeline steps, just estimated instead of
// server-confirmed. It's honest framing ("probably doing X now"), not a
// tracked fact, but it beats a single pulsing icon for telling the person
// something is actually happening.
const DEFAULT_DIAGNOSIS_STEPS = [
  { label: 'Reading error logs', atSeconds: 0 },
  { label: 'Identifying root cause', atSeconds: 6 },
  { label: 'Regenerating fixed files', atSeconds: 16 },
  { label: 'Verifying the fix', atSeconds: 28 },
];

export function DiagnosisLoading({ label = 'AI AGENT ANALYZING ERRORS...', steps = DEFAULT_DIAGNOSIS_STEPS }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const activeIndex = steps.reduce((acc, s, i) => (elapsed >= s.atSeconds ? i : acc), 0);

  return (
    <div className="border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-2 text-ink text-sm mb-3">
        <Bot size={16} className="animate-pulse" /> {label}
        <span className="ml-auto flex items-center gap-1 text-ink/55 text-xs font-mono tabular-nums">
          <Timer size={12} /> {formatRunTime(elapsed)}
        </span>
      </div>
      <div className="flex items-start gap-3">
        {/* Larger, unmissable spinning ring — matches MorpheusPipelineStatus's
            chat-pipeline indicator so long-running AI work reads the same way
            everywhere in the app. */}
        <div
          className="h-11 w-11 shrink-0 rounded-full border-[3px] border-primary/15 border-t-primary animate-spin shadow-[0_0_14px_rgba(0,255,65,0.45)]"
          aria-hidden="true"
        />
        <div className="space-y-1 flex-1 min-w-0 pt-0.5">
          {steps.map((s, i) => {
            const isActive = i === activeIndex;
            const isDone = i < activeIndex;
            return (
              <div key={s.label} className="flex items-baseline gap-2 text-xs">
                <span className={isActive ? 'text-ink animate-pulse' : isDone ? 'text-ink/50' : 'text-ink/30'} aria-hidden="true">
                  {isDone ? '✓' : isActive ? '>' : '·'}
                </span>
                <span className={isActive ? 'text-ink' : isDone ? 'text-ink/50' : 'text-ink/30'}>{s.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function DiagnosisPanel({ diagnosis, onRedeploy, redeployLabel = 'REDEPLOY', onAskMorpheus }) {
  if (!diagnosis) return null;

  return (
    <div className="border border-primary/40 bg-primary/5 p-3 space-y-3">
      <div className="flex items-center gap-2 text-primary text-sm">
        <Bot size={16} /> AI DIAGNOSIS COMPLETE
      </div>
      <p className="text-ink/80 text-sm">{diagnosis.summary}</p>

      {onAskMorpheus && (
        <button onClick={onAskMorpheus} className="flex items-center gap-1 text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-1.5 font-bold w-fit">
          <MessageSquare size={12} /> ASK MORPHEUS IN CHAT
        </button>
      )}

      {/* Auto-fixed items */}
      {diagnosis.autoFixed?.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-primary/75 uppercase flex items-center gap-1"><Wrench size={12} /> auto-fixed — ready to {redeployLabel.toLowerCase()}</div>
          {diagnosis.autoFixed.map((fix, i) => (
            <div key={i} className="border border-primary/30 bg-primary/5 p-2">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle size={12} className="text-primary shrink-0" />
                <span className="text-primary text-xs font-bold uppercase">{fix.component}</span>
                <span className="text-ink/75 text-xs">— {fix.fileCount} file(s) regenerated</span>
              </div>
              <p className="text-xs text-ink/60 ml-5">{fix.issue}</p>
              <p className="text-xs text-ink/80 ml-5 mt-0.5">Fix: {fix.fix}</p>
            </div>
          ))}
          {onRedeploy && (
            <div className="flex items-center gap-2">
              <button onClick={onRedeploy} className="flex items-center gap-1 text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-1.5 font-bold">
                <ArrowRight size={12} /> {redeployLabel}
              </button>
              <span className="text-xs text-ink/60">to push the fixed code live.</span>
            </div>
          )}
        </div>
      )}

      {/* Needs user action */}
      {diagnosis.needsUserAction?.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-yellow-500/60 uppercase flex items-center gap-1"><AlertTriangle size={12} /> needs your action</div>
          {diagnosis.needsUserAction.map((item, i) => (
            <div key={i} className={`border p-2 ${item.severity === 'credentials' ? 'border-yellow-500/40 bg-yellow-500/5' : 'border-primary/20'}`}>
              <div className="flex items-center gap-2 mb-1">
                {item.severity === 'credentials' ? <Key size={12} className="text-yellow-500 shrink-0" /> : <ExternalLink size={12} className="text-primary/60 shrink-0" />}
                <span className="text-primary text-xs font-bold uppercase">{item.component}</span>
                <span className="text-ink/50 text-xs">— {item.label}</span>
              </div>
              <p className="text-xs text-ink/70 mb-1.5 ml-5">{item.issue}</p>
              <div className="ml-5 space-y-0.5">
                {item.steps.map((step, j) => (
                  <div key={j} className="flex items-start gap-1.5 text-xs text-ink/50">
                    <span className="text-ink/65 shrink-0">{j + 1}.</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>
              {item.link && (
                item.link.startsWith('/') ? (
                  <Link to={item.link} className="inline-flex items-center gap-1 text-xs text-primary hover:underline border border-primary/30 hover:border-primary/60 px-2 py-1 mt-2 ml-5">
                    <LinkIcon size={10} /> GO TO SETTINGS
                  </Link>
                ) : (
                  <a href={item.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline border border-primary/30 hover:border-primary/60 px-2 py-1 mt-2 ml-5">
                    <ExternalLink size={10} /> OPEN LINK
                  </a>
                )
              )}
            </div>
          ))}
        </div>
      )}

      {diagnosis.allClear && !diagnosis.autoFixed?.length && (
        <div className="flex items-center gap-2 text-ink text-sm border-t border-primary/20 pt-2">
          <CheckCircle size={16} /> All clear — retry the operation.
        </div>
      )}
    </div>
  );
}