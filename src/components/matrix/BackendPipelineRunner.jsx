import { useState, useRef, useEffect } from 'react';
import { Square, Timer, Cloud, Wrench, CheckCircle, AlertTriangle, X, Heart } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useRunTimer } from '@/hooks/useRunTimer';

const PHASES = {
  deploying: { icon: Cloud, label: 'DEPLOYING', color: 'text-[#00ff41]' },
  health: { icon: Heart, label: 'HEALTH CHECK', color: 'text-[#00ff41]' },
  diagnosing: { icon: Wrench, label: 'AI FIXING', color: 'text-yellow-500' },
  done: { icon: CheckCircle, label: 'LIVE', color: 'text-[#00ff41]' },
  stuck: { icon: AlertTriangle, label: 'STUCK', color: 'text-red-500' },
  stopped: { icon: Square, label: 'STOPPED', color: 'text-yellow-500' },
};

export default function BackendPipelineRunner({ project, selectedComponents, onClose, onComplete }) {
  const [running, setRunning] = useState(true);
  const [phase, setPhase] = useState('deploying');
  const [logs, setLogs] = useState([]);
  const [finalResults, setFinalResults] = useState(null);
  const stopRef = useRef(false);
  const startedRef = useRef(false);
  const startTimeRef = useRef(Date.now());

  const addLog = (msg) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-40), { time, msg }]);
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Auto-start pipeline on mount
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const run = async () => {
      startTimeRef.current = Date.now();
      const maxIter = 8;
      for (let i = 0; i < maxIter; i++) {
        if (stopRef.current) break;

        // ── DEPLOY ──
        setPhase('deploying');
        addLog(`[${i + 1}] Deploying backend...`);
        let deployRes;
        try {
          const r = await base44.functions.invoke('deployBackend', {
            projectId: project.id,
            components: selectedComponents
          });
          deployRes = r.data;
        } catch (e) {
          addLog(`Deploy failed: ${e.message}`);
          break;
        }
        if (stopRef.current) break;

        const results = deployRes.results || [];
        const errorCount = results.filter(r => r.status === 'error').length;
        const deployedCount = results.filter(r => r.status === 'deployed').length;
        addLog(`[${i + 1}] Deploy: ${deployedCount} live, ${errorCount} errors.`);

        // If all deployed with no errors, go straight to health check
        if (errorCount === 0) {
          // ── HEALTH CHECK ──
          setPhase('health');
          addLog(`[${i + 1}] Checking health...`);
          // Async platforms (Railway/Render/Fly) need time to build
          await sleep(10000);
          if (stopRef.current) break;

          let healthy = false;
          try {
            const h = await base44.functions.invoke('checkDeployHealth', { projectId: project.id });
            healthy = h.data.healthy;
            addLog(`[${i + 1}] Health: ${healthy ? 'PASS' : 'FAIL'} (${h.data.statusCode || h.data.error || 'unreachable'})`);
          } catch (e) {
            addLog(`[${i + 1}] Health check error: ${e.message}`);
          }
          if (stopRef.current) break;

          if (healthy) {
            addLog('Backend is live and healthy! Pipeline complete.');
            setFinalResults(deployRes);
            setPhase('done');
            setRunning(false);
            onComplete?.(deployRes);
            return;
          }
          // Unhealthy — fall through to diagnosis
        }

        // ── AI DIAGNOSE + FIX ──
        setPhase('diagnosing');
        addLog(`[${i + 1}] Running AI diagnosis on deploy errors...`);
        let diag;
        try {
          const r = await base44.functions.invoke('diagnoseIssue', {
            type: 'deploy',
            projectId: project.id,
            errorContext: results,
            components: selectedComponents
          });
          diag = r.data.diagnosis;
        } catch (e) {
          addLog(`Diagnosis failed: ${e.message}`);
          break;
        }
        if (stopRef.current) break;

        if (!diag?.autoFixed?.length) {
          addLog('No auto-fixes available. Pipeline stuck.');
          setPhase('stuck');
          setRunning(false);
          onComplete?.(deployRes);
          return;
        }

        addLog(`[${i + 1}] AI fixed ${diag.autoFixed.length} issue(s). Looping back to redeploy...`);
        await sleep(1000);
      }

      setRunning(false);
      if (stopRef.current) setPhase('stopped');
      else {
        addLog('Max iterations reached. Pipeline stopped.');
        setPhase('stuck');
      }
    };
    run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStop = () => {
    stopRef.current = true;
    setRunning(false);
    setPhase('stopped');
  };

  const info = PHASES[phase] || PHASES.deploying;
  const Icon = info.icon;
  // Per-phase ETA: each phase has its own realistic duration, so the countdown
  // resets when the phase changes (deploy → health → diagnose → loop).
  const PHASE_ESTIMATE = { deploying: 120, health: 20, diagnosing: 60, done: 0, stuck: 0, stopped: 0 };
  const phaseStartRef = useRef(Date.now());
  useEffect(() => { phaseStartRef.current = Date.now(); }, [phase]);
  const phaseElapsed = Math.floor((Date.now() - phaseStartRef.current) / 1000);
  const phaseEstimate = PHASE_ESTIMATE[phase] ?? 60;
  const { timerStr, etaStr } = useRunTimer({
    running,
    startTimeRef,
    etaSeconds: running && phaseEstimate > 0 ? Math.max(0, phaseEstimate - phaseElapsed) : null,
  });

  return (
    <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 z-50 border border-[#00ff41]/40 bg-black shadow-[0_0_20px_rgba(0,255,65,0.2)] safe-bottom">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#00ff41]/20">
        <div className="flex items-center gap-2">
          <Icon size={16} className={`${info.color} ${running ? 'animate-pulse' : ''}`} />
          <span className={`font-display tracking-wider text-sm ${info.color}`}>{info.label}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 text-[#00ff41] font-mono text-sm">
            <Timer size={14} /> {timerStr}
            {etaStr && <span className="text-[#00ff41]/50 text-xs ml-1">/ ETA {etaStr}</span>}
          </div>
          {running ? (
            <button onClick={handleStop} className="flex items-center gap-1 text-xs text-black bg-red-500 hover:bg-red-400 px-3 py-1 font-bold">
              <Square size={12} /> STOP
            </button>
          ) : (
            <button onClick={onClose} className="text-[#00ff41]/60 hover:text-[#00ff41]">
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="max-h-32 overflow-y-auto scrollbar-matrix p-3 space-y-0.5">
        {logs.map((log, i) => (
          <div key={i} className="text-xs text-[#00ff41]/60 font-mono">
            <span className="text-[#00ff41]/65">{log.time} </span>
            {log.msg}
          </div>
        ))}
        {running && <div className="text-xs text-[#00ff41] animate-pulse">▊</div>}
      </div>
      {phase === 'done' && finalResults && (
        <div className="border-t border-[#00ff41]/20 p-3 space-y-2">
          <div className="flex items-center gap-2 text-[#00ff41] text-sm">
            <CheckCircle size={14} /> Backend live and healthy!
          </div>
          {finalResults.results?.filter(r => r.url).slice(0, 3).map((r, i) => (
            <a key={i} href={r.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 py-1.5 px-3 border border-[#00ff41]/40 hover:border-[#00ff41] hover:bg-[#00ff41]/10 transition-colors text-sm">
              <Cloud size={14} /> {r.label || r.service}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}