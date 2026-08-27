import { Bot, Loader2, CheckCircle, XCircle, Wrench, ArrowRight, AlertTriangle, Key, ExternalLink, Link as LinkIcon, MessageSquare } from 'lucide-react';
import { Link } from 'react-router-dom';

// Shared diagnosis results panel — renders the unified diagnosis shape returned
// by the diagnoseIssue backend function. Used across deploy, compile, github, and
// build flows for consistent Morpheus-wide AI assistance.

export function DiagnosisLoading({ label = 'AI AGENT ANALYZING ERRORS...' }) {
  return (
    <div className="border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-2 text-primary text-sm mb-2">
        <Bot size={16} className="animate-pulse" /> {label}
      </div>
      <div className="flex items-center gap-2 text-primary/60 text-xs">
        <Loader2 size={12} className="animate-spin" /> Diagnosing failures, regenerating broken files, and building action plan...
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
      <p className="text-primary/80 text-sm">{diagnosis.summary}</p>

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
                <span className="text-primary/75 text-xs">— {fix.fileCount} file(s) regenerated</span>
              </div>
              <p className="text-xs text-primary/60 ml-5">{fix.issue}</p>
              <p className="text-xs text-primary/80 ml-5 mt-0.5">Fix: {fix.fix}</p>
            </div>
          ))}
          {onRedeploy && (
            <div className="flex items-center gap-2">
              <button onClick={onRedeploy} className="flex items-center gap-1 text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-1.5 font-bold">
                <ArrowRight size={12} /> {redeployLabel}
              </button>
              <span className="text-xs text-primary/60">to push the fixed code live.</span>
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
                <span className="text-primary/50 text-xs">— {item.label}</span>
              </div>
              <p className="text-xs text-primary/70 mb-1.5 ml-5">{item.issue}</p>
              <div className="ml-5 space-y-0.5">
                {item.steps.map((step, j) => (
                  <div key={j} className="flex items-start gap-1.5 text-xs text-primary/50">
                    <span className="text-primary/65 shrink-0">{j + 1}.</span>
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
        <div className="flex items-center gap-2 text-primary text-sm border-t border-primary/20 pt-2">
          <CheckCircle size={16} /> All clear — retry the operation.
        </div>
      )}
    </div>
  );
}