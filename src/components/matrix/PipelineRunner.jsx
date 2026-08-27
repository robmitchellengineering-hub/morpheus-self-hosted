import { useState, useRef, useEffect } from 'react';
import { Square, Timer, Hammer, Wrench, MessageSquare, CheckCircle, AlertTriangle, Download, ExternalLink, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useRunTimer } from '@/hooks/useRunTimer';
import { getCompileEstimate } from '@/lib/compileEstimates';

const PHASES = {
  compiling: { icon: Hammer, label: 'COMPILING', color: 'text-primary' },
  diagnosing: { icon: Wrench, label: 'AI FIXING', color: 'text-yellow-500' },
  asking: { icon: MessageSquare, label: 'ASKING MORPHEUS', color: 'text-primary' },
  done: { icon: CheckCircle, label: 'COMPLETE', color: 'text-primary' },
  stuck: { icon: AlertTriangle, label: 'STUCK', color: 'text-red-500' },
  stopped: { icon: Square, label: 'STOPPED', color: 'text-yellow-500' },
};

function buildAskMessage(diagnosis, target) {
  const msg = [`The ${target || 'binary'} compile failed. AI diagnosis was run:`, '', diagnosis.summary];
  if (diagnosis.autoFixed?.length) {
    msg.push('', 'Auto-fixed:');
    diagnosis.autoFixed.forEach(f => msg.push(`- ${f.component}: ${f.fix} (${f.fileCount} file(s) regenerated)`));
  }
  if (diagnosis.needsUserAction?.length) {
    msg.push('', 'Still needs fixing:');
    diagnosis.needsUserAction.forEach(a => msg.push(`- ${a.component}: ${a.issue}`));
  }
  msg.push('', "Fix it according to any relevant scope and documentation. If none exists, fix it — let's get this code to compile.");
  return msg.join('\n');
}

export default function PipelineRunner({ project, sendMessage, compileProject, checkCompileStatus, loadFiles, onClose }) {
  const [running, setRunning] = useState(true);
  const [phase, setPhase] = useState('compiling');
  const [iteration, setIteration] = useState(1);
  const [logs, setLogs] = useState([]);
  const [finalStatus, setFinalStatus] = useState(null);
  const [compileProgress, setCompileProgress] = useState(null);
  const stopRef = useRef(false);
  const startedRef = useRef(false);
  const startTimeRef = useRef(Date.now());
  const sendRef = useRef(sendMessage);
  const compileRef = useRef(compileProject);
  const checkRef = useRef(checkCompileStatus);
  const loadFilesRef = useRef(loadFiles);

  sendRef.current = sendMessage;
  compileRef.current = compileProject;
  checkRef.current = checkCompileStatus;
  loadFilesRef.current = loadFiles;

  const addLog = (msg) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-40), { time, msg }]);
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const pollCompile = async (repoFullName) => {
    for (let i = 0; i < 120; i++) {
      if (stopRef.current) return null;
      await sleep(5000);
      try {
        const s = await checkRef.current(repoFullName);
        if (s.stepProgress) setCompileProgress(s.stepProgress);
        if (s.status === 'completed') return s;
      } catch {}
    }
    return null;
  };

  // Auto-start pipeline on mount
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const run = async () => {
      startTimeRef.current = Date.now();
      const maxIter = 10;
      for (let i = 0; i < maxIter; i++) {
        if (stopRef.current) break;

        // ── COMPILE ──
        setPhase('compiling');
        setIteration(i + 1);
        addLog(`[${i + 1}] Compiling ${project.compile_target || 'source'}...`);
        let res;
        try {
          res = await compileRef.current();
        } catch (e) {
          addLog(`Compile dispatch failed: ${e.message}`);
          break;
        }
        if (stopRef.current) break;
        if (!res) { addLog('No project selected.'); break; }
        if (res.error) { addLog(`Compile error: ${res.error}`); break; }

        addLog(`[${i + 1}] Polling build status...`);
        setCompileProgress(null);
        const status = await pollCompile(res.repoFullName);
        if (stopRef.current) break;
        if (!status) { addLog('Compile timed out (10 min).'); break; }
        if (status.conclusion === 'success') {
          addLog('Compile succeeded! Pipeline complete.');
          setFinalStatus(status);
          setPhase('done');
          setRunning(false);
          return;
        }

        // ── AI FIX ──
        addLog(`[${i + 1}] Build failed. Running AI diagnosis...`);
        setPhase('diagnosing');
        let diag;
        try {
          const r = await base44.functions.invoke('diagnoseIssue', {
            type: 'compile',
            projectId: project.id,
            errorContext: { error: 'Build failed. Check the run logs on GitHub.', repoUrl: res.repoUrl, target: project.compile_target, logs: status.logs }
          });
          diag = r.data;
        } catch (e) {
          addLog(`Diagnosis failed: ${e.message}`);
          break;
        }
        if (stopRef.current) break;
        if (!diag?.autoFixed?.length) {
          addLog('No auto-fixes available. Pipeline stuck.');
          setPhase('stuck');
          setRunning(false);
          return;
        }

        // Reload files after diagnosis applied fixes to the database
        try { await loadFilesRef.current?.(project.id); } catch {}

        // ── ASK MORPHEUS ──
        addLog(`[${i + 1}] AI fixed ${diag.autoFixed.length} item(s). Sending to Morpheus chat...`);
        setPhase('asking');
        const msg = buildAskMessage(diag, project.compile_target);
        await sendRef.current(msg, null, true);
        if (stopRef.current) break;
        await sleep(500);
        addLog(`[${i + 1}] Morpheus responded. Looping back to compile...`);
      }
      setRunning(false);
      if (stopRef.current) setPhase('stopped');
    };
    run();
  }, []);

  const handleStop = () => {
    stopRef.current = true;
    setRunning(false);
    setPhase('stopped');
  };

  const info = PHASES[phase] || PHASES.compiling;
  const Icon = info.icon;
  const { timerStr, etaStr } = useRunTimer({
    running,
    startTimeRef,
    progress: compileProgress ? { completed: compileProgress.completed, total: compileProgress.total } : null,
    estimateSeconds: getCompileEstimate(project.compile_target),
  });

  return (
    <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 z-50 border border-primary/40 bg-black shadow-[0_0_20px_rgba(0,255,65,0.2)] safe-bottom">
      <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20">
        <div className="flex items-center gap-2">
          <Icon size={16} className={`${info.color} ${running ? 'animate-pulse' : ''}`} />
          <span className={`font-display tracking-wider text-sm ${info.color}`}>{info.label}</span>
          {running && phase !== 'done' && (
            <span className="text-[10px] text-primary/50 font-display tracking-wider border border-primary/30 px-1.5 py-0.5">LOOP {iteration}/10</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 text-primary font-mono text-sm">
            <Timer size={14} /> {timerStr}
            {etaStr && <span className="text-primary/50 text-xs ml-1">/ ETA {etaStr}</span>}
          </div>
          {running ? (
            <button onClick={handleStop} className="flex items-center gap-1 text-xs text-black bg-red-500 hover:bg-red-400 px-3 py-1 font-bold">
              <Square size={12} /> STOP
            </button>
          ) : (
            <button onClick={onClose} className="text-primary/60 hover:text-primary">
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="max-h-32 overflow-y-auto scrollbar-matrix p-3 space-y-0.5">
        {logs.map((log, i) => (
          <div key={i} className="text-xs text-primary/60 font-mono">
            <span className="text-primary/65">{log.time} </span>
            {log.msg}
          </div>
        ))}
        {running && <div className="text-xs text-primary animate-pulse">▊</div>}
      </div>
      {phase === 'done' && finalStatus && (
        <div className="border-t border-primary/20 p-3 space-y-2">
          <div className="flex items-center gap-2 text-primary text-sm">
            <CheckCircle size={14} /> Build complete!
          </div>
          {finalStatus.assets?.map((a, i) => (
            <a key={i} href={a.downloadUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 py-1.5 px-3 border border-primary/40 hover:border-primary hover:bg-primary/10 transition-colors text-sm">
              <Download size={14} /> {a.name} ({(a.size / 1024 / 1024).toFixed(1)} MB)
            </a>
          ))}
          {finalStatus.releaseUrl && (
            <a href={finalStatus.releaseUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary/50 hover:text-primary">
              <ExternalLink size={12} /> View release on GitHub
            </a>
          )}
        </div>
      )}
      {phase === 'stuck' && (
        <div className="border-t border-red-500/30 p-3 space-y-2">
          <div className="flex items-center gap-2 text-red-500 text-sm">
            <AlertTriangle size={14} /> Pipeline stuck after {iteration} attempt(s)
          </div>
          <p className="text-[10px] text-primary/60 leading-relaxed">
            // The AI couldn't auto-fix the last failure. Open the chat, describe the build error to Morpheus, and ask for a fix — then run the pipeline again.
          </p>
        </div>
      )}
    </div>
  );
}