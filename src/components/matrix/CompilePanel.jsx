import { useState, useEffect, useRef, useCallback } from 'react';
import { Hammer, X, Loader2, CheckCircle, XCircle, Download, ExternalLink, Bot, Eye, Server, Wifi, Sliders, Timer, Square, RefreshCw } from 'lucide-react';
import GithubGate from '@/components/matrix/GithubGate';
import { useRunTimer } from '@/hooks/useRunTimer';
import { getCompileEstimate } from '@/lib/compileEstimates';
import NetworkFlashDialog from '@/components/matrix/NetworkFlashDialog';
import DistroConfigDialog from '@/components/matrix/DistroConfigDialog';
import LinuxDistroConfigDialog from '@/components/matrix/LinuxDistroConfigDialog';
import DiagnosisPanel, { DiagnosisLoading } from '@/components/matrix/DiagnosisPanel';
import { useDiagnosis } from '@/hooks/useDiagnosis';
import { base44 } from '@/api/base44Client';

const SUPPORTED = ['web-app', 'python-package', 'windows-exe', 'linux-binary', 'mac-app', 'android-apk', 'ios-app', 'rpi-distro', 'linux-distro', 'arduino-firmware'];

export default function CompilePanel({ open, onClose, project, onCompile, onPreview, onCheckStatus, onAskMorpheus, onCompileSuccess, onBuildBackend }) {
  const [phase, setPhase] = useState('idle');
  const [attempt, setAttempt] = useState(0);
  const [repoFullName, setRepoFullName] = useState(null);
  const [repoUrl, setRepoUrl] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [showNetFlash, setShowNetFlash] = useState(false);
  const [showDistroConfig, setShowDistroConfig] = useState(false);
  const [showLinuxDistroConfig, setShowLinuxDistroConfig] = useState(false);
  const pollRef = useRef(null);
  const pollStartRef = useRef(0);
  const stopRef = useRef(false);
  const startTimeRef = useRef(0);
  const errorCountRef = useRef(0);
  const autoLoopRef = useRef(0);
  const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — GitHub Actions builds can take a while
  const MAX_ERRORS = 5; // stop polling after 5 consecutive status-check failures
  const MAX_AUTO_LOOPS = 10; // cap unattended fix-loop iterations so it can't run forever
  const { diagnosis, diagnosing, diagnose, clearDiagnosis } = useDiagnosis();
  const notifiedRef = useRef(false);

  const target = project?.compile_target || 'source';
  const isSupported = SUPPORTED.includes(target);

  // Fires one completion email per compile session (success or final failure)
  // so the operator can step away during long auto-fix loops and be pulled back.
  const notifyComplete = useCallback(async (result, summary) => {
    if (notifiedRef.current) return;
    notifiedRef.current = true;
    try {
      await base44.functions.invoke('sendCompileCompleteEmail', {
        projectName: project?.name || 'project',
        target,
        result,
        summary: summary || ''
      });
    } catch (e) { /* silent — never block the build UI */ }
  }, [project?.name, target]);

  const { timerStr, etaStr } = useRunTimer({
    running: phase === 'polling',
    startTimeRef,
    progress: status?.stepProgress ? { completed: status.stepProgress.completed, total: status.stepProgress.total } : null,
    estimateSeconds: getCompileEstimate(target),
  });

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    setPhase('idle');
    setAttempt(0);
    setRepoFullName(null);
    setRepoUrl(null);
    setStatus(null);
    setError(null);
    setPreview(null);
    setPreviewing(false);
    errorCountRef.current = 0;
    autoLoopRef.current = 0;
    notifiedRef.current = false;
    stopRef.current = false;
    clearDiagnosis();
  }, [stopPolling, clearDiagnosis]);

  const handleStop = useCallback(() => {
    stopRef.current = true;
    stopPolling();
    setPhase('stopped');
    setError('Build stopped by operator. The GitHub Actions run keeps running on GitHub — cancel it there if needed.');
  }, [stopPolling]);

  const diagnoseCompile = async () => {
    await diagnose({
      type: 'compile',
      projectId: project.id,
      errorContext: { error, repoUrl, target, logs: status?.logs }
    });
  };

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const poll = useCallback(async (repo) => {
    if (stopRef.current) { stopPolling(); return; }
    try {
      // Bail out if we've been polling too long — GitHub Actions may be stuck
      if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
        stopPolling();
        setPhase('error');
        setError('Build timed out — no completion after 15 minutes of polling.');
        notifyComplete('failed', 'Build timed out after 15 minutes of polling');
        return;
      }
      const data = await onCheckStatus(repo);
      // If the status check itself returned an error (not a build failure),
      // count it. After MAX_ERRORS consecutive failures, stop and show the user
      // instead of silently polling forever.
      if (data?.error) {
        errorCountRef.current += 1;
        if (errorCountRef.current >= MAX_ERRORS) {
          stopPolling();
          setPhase('error');
          setError(`Status check failed ${MAX_ERRORS} times: ${data.error}`);
          notifyComplete('failed', `Status check failed ${MAX_ERRORS} times: ${data.error}`);
        }
        return;
      }
      // Success — reset the error counter
      errorCountRef.current = 0;
      setStatus(data);
      if (data.status === 'completed') {
        stopPolling();
        if (data.conclusion === 'success') {
          setPhase('saving');
          // Save the compiled artifacts back to the project's file tree.
          // This downloads the binary from GitHub and re-uploads to storage —
          // it takes a few seconds. We await it so the user sees a saving
          // state and any error, instead of a silent failure that leaves them
          // wondering where their app is.
          try {
            const saveResult = await onCompileSuccess?.(repo);
            if (saveResult?.error) {
              setPhase('error');
              setError(`Build succeeded but the compiled app couldn't be saved to your files: ${saveResult.error}. Tap RECOMPILE to retry, or download it directly from GitHub below.`);
              notifyComplete('failed', `Artifact save failed: ${saveResult.error}`);
              return;
            }
          } catch (saveErr) {
            setPhase('error');
            setError(`Build succeeded but saving the artifact failed: ${saveErr?.message || saveErr}. Tap RECOMPILE to retry.`);
            notifyComplete('failed', `Artifact save failed: ${saveErr?.message || saveErr}`);
            return;
          }
          setPhase('done');
          notifyComplete('success', 'Build complete');
        } else {
          setPhase('error');
          setError('Build failed. Fetching logs and diagnosing...');
          // Auto-run diagnosis, then — if the agent fixed files — automatically
          // recompile to test the fix. The loop runs unattended until the build
          // passes or the agent can't auto-fix (then it stops and surfaces what
          // needs manual action).
          if (data.logs?.length > 0) {
            const diag = await diagnose({
              type: 'compile',
              projectId: project.id,
              errorContext: { error: 'Build failed on GitHub Actions', repoUrl, target, logs: data.logs }
            });
            if (stopRef.current) return;
            if (diag?.autoFixed?.length > 0) {
              handleCompile(true);
              return;
            }
            notifyComplete('failed', diag?.needsUserAction?.length ? 'Build needs manual fixes — ask Morpheus in chat' : 'Build failed — AI could not auto-fix');
          } else {
            setError('Build failed. Check the run logs on GitHub.');
            notifyComplete('failed', 'Build failed — no logs available');
          }
        }
      }
    } catch (e) {
      // Count exceptions too — don't silently poll forever on repeated failures
      errorCountRef.current += 1;
      if (errorCountRef.current >= MAX_ERRORS) {
        stopPolling();
        setPhase('error');
        setError(`Status check keeps failing: ${e.message || e}`);
        notifyComplete('failed', `Status check keeps failing: ${e.message || e}`);
      }
    }
  }, [onCheckStatus, stopPolling, onCompileSuccess, notifyComplete]);

  const handleCompile = async (isAuto = false) => {
    if (isAuto) {
      autoLoopRef.current += 1;
      if (autoLoopRef.current > MAX_AUTO_LOOPS) {
        setPhase('error');
        setError(`Auto-fix loop stopped after ${MAX_AUTO_LOOPS} attempts. Review the build logs or ask Morpheus in chat to resolve it.`);
        notifyComplete('failed', `Auto-fix loop stopped after ${MAX_AUTO_LOOPS} attempts`);
        return;
      }
    } else {
      autoLoopRef.current = 0;
      notifiedRef.current = false;
    }
    stopRef.current = false;
    startTimeRef.current = Date.now();
    setAttempt(a => a + 1);
    setPhase('compiling');
    setError(null);
    clearDiagnosis();
    try {
      const res = await onCompile();
      if (res.error) {
        setPhase('error');
        setError(res.error);
        notifyComplete('failed', `Compile dispatch failed: ${res.error}`);
        return;
      }
      setRepoFullName(res.repoFullName);
      setRepoUrl(res.repoUrl);
      setPhase('polling');
      pollStartRef.current = Date.now();
      errorCountRef.current = 0;
      setTimeout(() => poll(res.repoFullName), 3000);
      pollRef.current = setInterval(() => poll(res.repoFullName), 5000);
    } catch (e) {
      setPhase('error');
      setError(e.message);
      notifyComplete('failed', `Compile dispatch failed: ${e.message}`);
    }
  };

  const handlePreview = async () => {
    setPreviewing(true);
    setPreview(null);
    try {
      const res = await onPreview();
      if (res?.error) {
        setPreview({ error: res.error });
      } else {
        setPreview(res);
      }
    } catch (e) {
      setPreview({ error: e.message || String(e) });
    } finally {
      setPreviewing(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-lg border border-[#00ff41]/40 bg-black shadow-[0_0_20px_rgba(0,255,65,0.2)]">
        <div className="flex items-center justify-between border-b border-[#00ff41]/20 px-4 py-3">
          <div className="flex items-center gap-2">
            <Hammer size={16} className="text-[#00ff41]" />
            <span className="text-[#00ff41] font-display tracking-wider neon-glow">COMPILE</span>
          </div>
          <button onClick={onClose} className="text-[#00ff41]/60 hover:text-[#00ff41]"><X size={18} /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-sm text-[#00ff41]/60">
            Target: <span className="text-[#00ff41] uppercase">{target}</span>
          </div>
          {target === 'source' && (
            <p className="text-xs text-[#00ff41]/50">
              // Source target doesn't need compilation. Use the ZIP button to download raw source.
            </p>
          )}
          {!isSupported && target !== 'source' && (
            <p className="text-xs text-yellow-500/80">
              // Remote compilation not yet supported for this target. Use ZIP export for source.
            </p>
          )}
          {phase === 'idle' && isSupported && (
            <>
              <GithubGate note="Connect your GitHub account so Morpheus can build your binary via GitHub Actions.">
                <button onClick={() => handleCompile(false)} className="w-full flex items-center justify-center gap-2 py-3 border border-[#00ff41] text-[#00ff41] hover:bg-[#00ff41] hover:text-black transition-colors font-bold">
                  <Hammer size={16} /> COMPILE NOW
                </button>
              </GithubGate>
              {target === 'rpi-distro' && (
                <button onClick={() => setShowDistroConfig(true)} className="w-full flex items-center justify-center gap-2 py-2 border border-[#00ff41]/40 text-[#00ff41]/70 hover:border-[#00ff41] hover:text-[#00ff41] transition-colors text-xs">
                  <Sliders size={14} /> CONFIGURE DISTRO
                </button>
              )}
              {target === 'linux-distro' && (
                <button onClick={() => setShowLinuxDistroConfig(true)} className="w-full flex items-center justify-center gap-2 py-2 border border-[#00ff41]/40 text-[#00ff41]/70 hover:border-[#00ff41] hover:text-[#00ff41] transition-colors text-xs">
                  <Sliders size={14} /> CONFIGURE DISTRO
                </button>
              )}
              <button onClick={handlePreview} disabled={previewing} className="w-full flex items-center justify-center gap-2 py-2 border border-[#00ff41]/40 text-[#00ff41]/70 hover:border-[#00ff41] hover:text-[#00ff41] transition-colors text-xs disabled:opacity-40">
                {previewing ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />} PREVIEW BUILD (DRY RUN)
              </button>
              {preview?.error && (
                <div className="text-xs text-red-500 border border-red-500/30 p-2">{preview.error}</div>
              )}
              {preview && !preview.error && (
                <div className="space-y-2 border border-[#00ff41]/20 bg-black p-3">
                  <div className="text-xs text-[#00ff41]/60">// BUILD PREVIEW — {preview.label} on {preview.runner}</div>
                  {preview.validation?.warnings?.length > 0 && (
                    <div className="text-[10px] text-yellow-500/80">
                      {preview.validation.warnings.map((w, i) => <div key={i}>! {w}</div>)}
                    </div>
                  )}
                  {preview.generatedFiles?.length > 0 && (
                    <div>
                      <div className="text-[10px] text-[#00ff41]/50 mb-1">AUTO-GENERATED FILES ({preview.generatedFiles.length}):</div>
                      <ul className="text-[10px] text-[#00ff41]/70 space-y-0.5">
                        {preview.generatedFiles.map(f => <li key={f} className="font-mono">+ {f}</li>)}
                      </ul>
                    </div>
                  )}
                  <div className="text-[10px] text-[#00ff41]/50">
                    ARTIFACT: {preview.artifact?.artifactName || preview.artifact?.glob} ({preview.totalFiles} files)
                  </div>
                  <details className="border border-[#00ff41]/20">
                    <summary className="text-[10px] text-[#00ff41]/60 cursor-pointer px-2 py-1 hover:text-[#00ff41]">WORKFLOW YAML (click to expand)</summary>
                    <pre className="text-[9px] text-[#00ff41]/50 overflow-x-auto max-h-48 p-2 scrollbar-matrix whitespace-pre-wrap">{preview.workflow}</pre>
                  </details>
                </div>
              )}
            </>
          )}
          {phase === 'compiling' && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[#00ff41]/60 text-sm">
                <Loader2 size={16} className="animate-spin" /> {attempt > 1 ? 'Recompiling to test AI fix...' : 'Dispatching build to GitHub Actions...'}
              </div>
              {attempt > 1 && <span className="text-[10px] text-[#00ff41]/50 font-display tracking-wider">ATTEMPT {attempt}</span>}
            </div>
          )}
          {phase === 'polling' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between border border-[#00ff41]/20 bg-[#00ff41]/5 px-3 py-2">
                <div className="flex items-center gap-3 text-[#00ff41] font-mono text-sm">
                  <span className="flex items-center gap-1"><Timer size={14} /> {timerStr}</span>
                  {etaStr && <span className="text-[#00ff41]/60 text-xs">ETA {etaStr}</span>}
                </div>
                <button onClick={handleStop} className="flex items-center gap-1 text-xs text-black bg-red-500 hover:bg-red-400 px-3 py-1 font-bold">
                  <Square size={12} /> STOP
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[#00ff41]/60 text-sm">
                  <Loader2 size={16} className="animate-spin" /> {status?.message || 'Build queued...'}
                </div>
                {attempt > 1 && <span className="text-[10px] text-[#00ff41]/50 font-display tracking-wider">ATTEMPT {attempt}</span>}
              </div>
              {status?.stepProgress && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-[#00ff41]/70">
                    <span className="font-mono">STEP {status.stepProgress.completed}/{status.stepProgress.total}</span>
                    <span className="text-[#00ff41]/50 truncate ml-2 text-right">{status.stepProgress.currentStep}</span>
                  </div>
                  <div className="h-1.5 bg-[#00ff41]/10 border border-[#00ff41]/20 overflow-hidden">
                    <div
                      className="h-full bg-[#00ff41] transition-all duration-500"
                      style={{ width: `${status.stepProgress.total > 0 ? (status.stepProgress.completed / status.stepProgress.total) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              )}
              {errorCountRef.current > 0 && (
                <p className="text-xs text-yellow-500/80">
                  // Status check retrying ({errorCountRef.current}/{MAX_ERRORS}) — GitHub may be indexing the workflow...
                </p>
              )}
              {repoUrl && (
                <a href={repoUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-[#00ff41]/50 hover:text-[#00ff41]">
                  <ExternalLink size={12} /> View repo on GitHub
                </a>
              )}
            </div>
          )}
          {phase === 'saving' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-[#00ff41] text-sm">
                <Loader2 size={16} className="animate-spin" /> Saving compiled app to your files...
              </div>
              <p className="text-xs text-[#00ff41]/50">
                // Downloading the binary from GitHub and storing it under _compiled/. This takes a few seconds — don't close this panel.
              </p>
            </div>
          )}
          {phase === 'done' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-[#00ff41] text-sm">
                <CheckCircle size={16} /> Build complete!
              </div>
              <p className="text-xs text-[#00ff41]/50">
                // Compiled package saved to your file tree under _compiled/. Switch to the FILES tab to download.
              </p>
              {status?.assets?.length === 0 && (
                <p className="text-xs text-yellow-500/80">
                  // Build succeeded but published no downloadable artifact. Check the release on GitHub.
                </p>
              )}
              {status?.assets?.map((a, i) => (
                <a key={i} href={a.downloadUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 py-2 px-3 border border-[#00ff41]/40 hover:border-[#00ff41] hover:bg-[#00ff41]/10 transition-colors text-sm">
                  <Download size={14} /> {a.name} ({(a.size / 1024 / 1024).toFixed(1)} MB)
                </a>
              ))}
              {status?.releaseUrl && (
                <a href={status.releaseUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-[#00ff41]/50 hover:text-[#00ff41]">
                  <ExternalLink size={12} /> View release on GitHub
                </a>
              )}
              {(target === 'rpi-distro' || target === 'linux-distro') && (
                <div className="border border-[#00ff41]/30 bg-[#00ff41]/5 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-[#00ff41] text-sm">
                    <Wifi size={14} /> {target === 'rpi-distro' ? 'Write to a Pi over the network' : 'Write to a server over the network'}
                  </div>
                  <p className="text-xs text-[#00ff41]/60">
                    // Enter your Pi's SSH details and Morpheus builds a command that pulls the image from storage and writes it to the device — no SD card swapping.
                  </p>
                  <button onClick={() => setShowNetFlash(true)} className="flex items-center gap-2 w-full justify-center py-2.5 border border-[#00ff41] text-[#00ff41] hover:bg-[#00ff41] hover:text-black transition-colors text-sm font-bold">
                    <Wifi size={14} /> TRANSFER OVER NETWORK
                  </button>
                </div>
              )}
              {onBuildBackend && (
                <div className="border border-[#00ff41]/30 bg-[#00ff41]/5 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-[#00ff41] text-sm">
                    <Server size={14} /> Does your app need a backend?
                  </div>
                  <p className="text-xs text-[#00ff41]/60">
                    // Congrats on the compile! If your app needs a server, database, or API, Morpheus can auto-generate and deploy one now.
                  </p>
                  <button onClick={onBuildBackend} className="flex items-center gap-2 w-full justify-center py-2.5 border border-[#00ff41] text-[#00ff41] hover:bg-[#00ff41] hover:text-black transition-colors text-sm font-bold">
                    <Server size={14} /> AUTO-GENERATE BACKEND
                  </button>
                </div>
              )}
            </div>
          )}
          {phase === 'error' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-red-500 text-sm">
                  <XCircle size={16} /> BUILD FAILED
                </div>
                {attempt > 0 && (
                  <span className="text-[10px] text-[#00ff41]/50 font-display tracking-wider">ATTEMPT {attempt}</span>
                )}
              </div>

              {/* Fix-loop guide — gives people the mental model so the
                  iterative diagnose → fix → recompile cycle isn't a mystery. */}
              <div className="border border-[#00ff41]/20 bg-[#00ff41]/5 p-2.5 text-xs text-[#00ff41]/65 space-y-0.5">
                <p className="text-[#00ff41]/80 font-bold uppercase tracking-wider text-[10px] flex items-center gap-1">
                  <RefreshCw size={10} className="animate-spin" /> FIX LOOP <span className="text-[#00ff41]/50 normal-case tracking-normal font-normal">// runs automatically</span>
                </p>
                <p>// 1. AI reads the build logs and auto-fixes what it can.</p>
                <p>// 2. Morpheus recompiles to test the fix — no action needed.</p>
                <p>// 3. Fails again? It loops again. Stops only when stuck or you hit STOP.</p>
                <p className="text-[#00ff41]/45 pt-0.5">// Each fix is saved to your files — you never lose progress.</p>
              </div>

              {error && error !== 'Build failed. Fetching logs and diagnosing...' && (
                <p className="text-xs text-red-500/80">{error}</p>
              )}

              {status?.logs?.length > 0 && (
                <details className="border border-[#00ff41]/20 bg-black">
                  <summary className="text-xs text-[#00ff41]/60 cursor-pointer px-3 py-1.5 hover:text-[#00ff41]">BUILD LOGS (click to expand)</summary>
                  <pre className="text-[10px] text-[#00ff41]/50 overflow-x-auto max-h-48 p-3 scrollbar-matrix whitespace-pre-wrap">{status.logs.map(l => `=== ${l.job} ===\n${l.log}`).join('\n\n')}</pre>
                </details>
              )}
              {repoUrl && (
                <a href={repoUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-[#00ff41]/50 hover:text-[#00ff41]">
                  <ExternalLink size={12} /> Check run logs on GitHub
                </a>
              )}

              {!diagnosis && !diagnosing && (
                <button onClick={diagnoseCompile} disabled={diagnosing} className="flex items-center gap-1 text-xs text-[#00ff41] hover:text-[#00ff41] px-3 py-2 border border-[#00ff41]/50 hover:border-[#00ff41] disabled:opacity-30 w-fit">
                  {diagnosing ? <Loader2 size={12} className="animate-spin" /> : <Bot size={12} />} AI DIAGNOSE & FIX
                </button>
              )}
              {diagnosing && <DiagnosisLoading label="AI AGENT ANALYZING BUILD ERRORS..." />}
              {diagnosis && !diagnosing && (
                <>
                  <DiagnosisPanel diagnosis={diagnosis} onRedeploy={() => handleCompile(false)} redeployLabel="RECOMPILE" onAskMorpheus={() => onAskMorpheus?.(diagnosis)} />
                  {diagnosis.needsUserAction?.length > 0 && !diagnosis.autoFixed?.length && (
                    <p className="text-[10px] text-[#00ff41]/50 leading-relaxed">
                      // Ask Morpheus to fix the remaining issues in chat, then reopen COMPILE and run again to test.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          {phase === 'stopped' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-yellow-500 text-sm">
                <Square size={16} /> {error || 'Build stopped.'}
              </div>
              {repoUrl && (
                <a href={repoUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-[#00ff41]/50 hover:text-[#00ff41]">
                  <ExternalLink size={12} /> Cancel the run on GitHub
                </a>
              )}
              <button onClick={reset} className="flex items-center gap-1 text-xs text-[#00ff41] px-3 py-2 border border-[#00ff41]/50 hover:border-[#00ff41] w-fit">
                <Hammer size={12} /> RECOMPILE
              </button>
            </div>
          )}
        </div>
      </div>
      <NetworkFlashDialog key={target} open={showNetFlash} onClose={() => setShowNetFlash(false)} projectId={project.id} target={target} />
      <DistroConfigDialog open={showDistroConfig} onClose={() => setShowDistroConfig(false)} projectId={project.id} />
      <LinuxDistroConfigDialog open={showLinuxDistroConfig} onClose={() => setShowLinuxDistroConfig(false)} projectId={project.id} />
    </div>
  );
}