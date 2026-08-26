import { useState, useEffect, useRef, useCallback } from 'react';
import { Hammer, X, Loader2, CheckCircle, XCircle, Download, ExternalLink, Bot, Eye, Server } from 'lucide-react';
import GithubGate from '@/components/matrix/GithubGate';
import DiagnosisPanel, { DiagnosisLoading } from '@/components/matrix/DiagnosisPanel';
import { useDiagnosis } from '@/hooks/useDiagnosis';

const SUPPORTED = ['web-app', 'python-package', 'windows-exe', 'linux-binary', 'mac-app', 'android-apk', 'ios-app', 'rpi-distro', 'arduino-firmware'];

export default function CompilePanel({ open, onClose, project, onCompile, onPreview, onCheckStatus, onAskMorpheus, onCompileSuccess, onBuildBackend }) {
  const [phase, setPhase] = useState('idle');
  const [repoFullName, setRepoFullName] = useState(null);
  const [repoUrl, setRepoUrl] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const pollRef = useRef(null);
  const pollStartRef = useRef(0);
  const errorCountRef = useRef(0);
  const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — GitHub Actions builds can take a while
  const MAX_ERRORS = 5; // stop polling after 5 consecutive status-check failures
  const { diagnosis, diagnosing, diagnose, clearDiagnosis } = useDiagnosis();

  const target = project?.compile_target || 'source';
  const isSupported = SUPPORTED.includes(target);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    setPhase('idle');
    setRepoFullName(null);
    setRepoUrl(null);
    setStatus(null);
    setError(null);
    setPreview(null);
    setPreviewing(false);
    errorCountRef.current = 0;
    clearDiagnosis();
  }, [stopPolling, clearDiagnosis]);

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
    try {
      // Bail out if we've been polling too long — GitHub Actions may be stuck
      if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
        stopPolling();
        setPhase('error');
        setError('Build timed out — no completion after 15 minutes of polling.');
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
        }
        return;
      }
      // Success — reset the error counter
      errorCountRef.current = 0;
      setStatus(data);
      if (data.status === 'completed') {
        stopPolling();
        if (data.conclusion === 'success') {
          setPhase('done');
          // Save the compiled artifacts back to the project's file tree
          onCompileSuccess?.(repo);
        } else {
          setPhase('error');
          setError('Build failed. Fetching logs and diagnosing...');
          // Auto-trigger AI diagnosis with the fetched logs so the user
          // doesn't have to manually click — feed the real build errors back.
          if (data.logs?.length > 0) {
            diagnose({
              type: 'compile',
              projectId: project.id,
              errorContext: { error: 'Build failed on GitHub Actions', repoUrl, target, logs: data.logs }
            });
          } else {
            setError('Build failed. Check the run logs on GitHub.');
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
      }
    }
  }, [onCheckStatus, stopPolling, onCompileSuccess]);

  const handleCompile = async () => {
    setPhase('compiling');
    setError(null);
    try {
      const res = await onCompile();
      if (res.error) {
        setPhase('error');
        setError(res.error);
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
                <button onClick={handleCompile} className="w-full flex items-center justify-center gap-2 py-3 border border-[#00ff41] text-[#00ff41] hover:bg-[#00ff41] hover:text-black transition-colors font-bold">
                  <Hammer size={16} /> COMPILE NOW
                </button>
              </GithubGate>
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
            <div className="flex items-center gap-2 text-[#00ff41]/60 text-sm">
              <Loader2 size={16} className="animate-spin" /> Dispatching build to GitHub Actions...
            </div>
          )}
          {phase === 'polling' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-[#00ff41]/60 text-sm">
                <Loader2 size={16} className="animate-spin" /> {status?.message || 'Build queued...'}
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
              <div className="flex items-center gap-2 text-red-500 text-sm">
                <XCircle size={16} /> {error || 'Build failed'}
              </div>
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
              <button onClick={diagnoseCompile} disabled={diagnosing} className="flex items-center gap-1 text-xs text-[#00ff41] hover:text-[#00ff41] px-3 py-2 border border-[#00ff41]/50 hover:border-[#00ff41] disabled:opacity-30 w-fit">
                {diagnosing ? <Loader2 size={12} className="animate-spin" /> : <Bot size={12} />} AI DIAGNOSE & FIX
              </button>
              {diagnosing && <DiagnosisLoading label="AI AGENT ANALYZING BUILD ERRORS..." />}
              {diagnosis && !diagnosing && (
                <DiagnosisPanel diagnosis={diagnosis} onRedeploy={handleCompile} redeployLabel="RECOMPILE" onAskMorpheus={() => onAskMorpheus?.(diagnosis)} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}