import { useState, useEffect, useRef, useCallback } from 'react';
import { Hammer, X, Loader2, CheckCircle, XCircle, AlertTriangle, Download, ExternalLink, Bot, Eye, Server, Wifi, Sliders, Timer, Square, RefreshCw, Rocket, Copy, Check } from 'lucide-react';
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

// 2026-09-04 (Rob: "i need an eta timer and larger spinning circle with
// steps in the compile ai fix window, its hard to tell its doing anything")
// — the dispatch step (pushing files + triggering the GitHub Actions run)
// has no real progress events of its own, so these steps advance on an
// elapsed-time heuristic rather than tracked fact — same approach as the AI
// diagnose steps in DiagnosisPanel.jsx. It's an honest "probably doing X
// now" indicator, not a guarantee, but it beats a single spinner line for
// telling Rob something is actually happening.
const DISPATCH_STEPS = [
  { label: 'Packaging project files', atSeconds: 0 },
  { label: 'Pushing to GitHub', atSeconds: 3 },
  { label: 'Triggering GitHub Actions run', atSeconds: 8 },
];

const COMPILE_DIAGNOSIS_STEPS = [
  { label: 'Reading build logs', atSeconds: 0 },
  { label: 'Identifying root cause', atSeconds: 6 },
  { label: 'Regenerating fixed files', atSeconds: 16 },
  { label: 'Preparing to recompile', atSeconds: 28 },
];

// Larger, unmissable spinning ring — matches MorpheusPipelineStatus's
// chat-pipeline indicator so long builds read the same way everywhere.
function BigSpinner({ className = '' }) {
  return (
    <div
      className={`h-11 w-11 shrink-0 rounded-full border-[3px] border-primary/15 border-t-primary animate-spin shadow-[0_0_14px_rgba(0,255,65,0.45)] ${className}`}
      aria-hidden="true"
    />
  );
}

// Renders a step list where progress is estimated from elapsed time rather
// than a real completed/total count (used when the underlying operation is
// a single opaque call with no progress events of its own).
function HeuristicStepList({ steps, elapsedSeconds }) {
  const activeIndex = steps.reduce((acc, s, i) => (elapsedSeconds >= s.atSeconds ? i : acc), 0);
  return (
    <div className="space-y-1 flex-1 min-w-0">
      {steps.map((s, i) => {
        const isActive = i === activeIndex;
        const isDone = i < activeIndex;
        return (
          <div key={s.label} className="flex items-baseline gap-2 text-xs">
            <span className={isActive ? 'text-ink-strong animate-pulse' : isDone ? 'text-ink-strong' : 'text-ink-strong'} aria-hidden="true">
              {isDone ? '✓' : isActive ? '>' : '·'}
            </span>
            <span className={isActive ? 'text-ink-strong' : isDone ? 'text-ink-strong' : 'text-ink-strong'}>{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function CompilePanel({ open, onClose, project, onCompile, onPreview, onCheckStatus, onAskMorpheus, onCompileSuccess, onBuildBackend }) {
  const [phase, setPhase] = useState('idle');
  const [attempt, setAttempt] = useState(0);
  const [repoFullName, setRepoFullName] = useState(null);
  const [repoUrl, setRepoUrl] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  // Compiled artifacts that were part of the release but did NOT save (a
  // partial save). Empty on every complete build.
  const [saveFailures, setSaveFailures] = useState([]);
  // "Take it live" (2026-09-28) — takes the compiled web app live on the user's
  // OWN Netlify account. Cleared with the rest of the panel when it closes, then
  // HYDRATED from the deploy record on open (see the getFrontendLive effect below):
  // a deploy result is not this component's to remember, because the site outlives
  // the panel. `stale`/`noArtifact` come back with it so a live-but-behind site says
  // so instead of offering a RE-DEPLOY that would publish the old build.
  const [live, setLive] = useState({ phase: 'idle', url: null, error: null, code: null });
  const [linkCopied, setLinkCopied] = useState(false);
  // The ref is what actually stops a second press in the same tick — React
  // state is not visible to it yet. Same failure the deck's add guard was
  // written for (Rob, 2026-09-28: "i was able to hot the button twice ... it
  // needs to be obvious something is happening and you need to wait").
  const liveInFlight = useRef(false);
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
  const dispatchRetryRef = useRef(0);
  const [dispatchRetryAttempt, setDispatchRetryAttempt] = useState(0);
  // Which provider mode this app is in, and the words for it. Read from the same
  // server module that writes the app's README section, so the panel and the README
  // cannot disagree. Shown in the panel because the README is not where anyone looks
  // while they are pressing COMPILE — and the point of the honesty half is that
  // Morpheus says which mode an app is in BEFORE anyone runs it.
  const [provider, setProvider] = useState(null);
  const [grant, setGrant] = useState(null); // { phase, token, appId, error }
  const [tokenCopied, setTokenCopied] = useState(false);
  const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — GitHub Actions builds can take a while
  const MAX_ERRORS = 5; // stop polling after 5 consecutive status-check failures
  const MAX_AUTO_LOOPS = 10; // cap unattended fix-loop iterations so it can't run forever
  // 2026-09-04 (Rob: "can we automate it from compile with that error"):
  // server/src/lib/github.js's pushFiles already retries GitRPC::BadObjectState
  // hard for ~75s before giving up — this is the layer above that. If the
  // whole dispatch still comes back with that error (or the "known
  // GitHub-side timing issue" text the backend adds when it exhausts its own
  // retries), it's still worth an automatic fresh attempt: each retry here
  // dispatches against a brand-new, timestamped build repo (see
  // compileProject.js's repoName), so it isn't repeating the exact same
  // request, it's giving GitHub's object store another clean shot. Only
  // fires for this specific, identified-transient error — anything else
  // still surfaces immediately rather than silently retrying a real failure.
  const MAX_DISPATCH_RETRIES = 3;
  const TRANSIENT_GITHUB_TIMING_RE = /BadObjectState|known GitHub-side timing issue/i;
  const { diagnosis, diagnosing, diagnose, clearDiagnosis } = useDiagnosis();
  const notifiedRef = useRef(false);

  const target = project?.compile_target || 'source';
  const isSupported = SUPPORTED.includes(target);
  // One source of truth for "the publish is running": it disables the control
  // AND drives the sentence that says why, so a greyed-out button never reads
  // as a dead one.
  const liveBusy = live.phase === 'deploying';

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

  // Separate timer scoped to the dispatch phase (pushing to GitHub +
  // triggering the run) — startTimeRef is set at the top of handleCompile,
  // before phase flips to 'compiling', so this reads the same clock.
  const { timerStr: dispatchTimerStr, elapsed: dispatchElapsed } = useRunTimer({
    running: phase === 'compiling',
    startTimeRef,
    estimateSeconds: 20,
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
    setSaveFailures([]);
    setLive({ phase: 'idle', url: null, error: null, code: null });
    setLinkCopied(false);
    liveInFlight.current = false;
    setPreview(null);
    setPreviewing(false);
    errorCountRef.current = 0;
    autoLoopRef.current = 0;
    dispatchRetryRef.current = 0;
    setDispatchRetryAttempt(0);
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

  // The URL has to survive the page. This panel's state is cleared when it closes, so
  // "is this construct live?" is READ BACK from the deploy record rather than remembered
  // — otherwise a user who closes the panel loses the only thing the deploy produced,
  // while the site stays live and the button offers TAKE IT LIVE again. A read failure
  // leaves the panel exactly as it was: a failed lookup must never be rendered as "not
  // deployed", which would invite a pointless second deploy.
  useEffect(() => {
    if (!open || !project?.id) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await base44.functions.invoke('getFrontendLive', { projectId: project.id });
        if (cancelled || liveInFlight.current) return; // never overwrite a deploy in flight
        if (data?.live && data.url) {
          setLive({ phase: 'live', url: data.url, stale: !!data.stale, noArtifact: !!data.noArtifact, error: null, code: null });
        }
      } catch { /* leave the panel as it was — see above */ }
    })();
    return () => { cancelled = true; };
  }, [open, project?.id]);

  // Ask the server which mode this app is in, every time the panel opens. A failed
  // read shows nothing rather than a guess: an error here must never be rendered as
  // "nothing to set up", which is the one claim that has to be true.
  useEffect(() => {
    let cancelled = false;
    if (!open || !project?.id) { setProvider(null); return undefined; }
    base44.functions.invoke('getAppProviderSetup', { projectId: project.id })
      .then((r) => { if (!cancelled) setProvider(r?.data || null); })
      .catch(() => { if (!cancelled) setProvider(null); });
    setGrant(null);
    setTokenCopied(false);
    return () => { cancelled = true; };
  }, [open, project?.id]);

  // Mint the capability token for this app. The response carries the token ONCE —
  // the server keeps only its hash — so the panel shows it and says, there and
  // then, that it belongs in a backend and not in a page.
  const createGrant = async () => {
    setGrant({ phase: 'creating' });
    try {
      const r = await base44.functions.invoke('appCapabilityGrant', { projectId: project.id, action: 'create' });
      setGrant({ phase: 'done', token: r?.data?.token, appId: r?.data?.appId, warning: r?.data?.warning });
    } catch (e) {
      setGrant({ phase: 'error', error: e?.message || 'Could not create the grant.' });
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(grant?.token || '');
      setTokenCopied(true);
    } catch { setTokenCopied(false); }
  };

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
          // A partial save is not a failed build — the assets that landed are
          // kept on screen — but it is not "complete" either, so the success
          // notification is skipped for it below.
          let saveWasPartial = false;
          try {
            const saveResult = await onCompileSuccess?.(repo);
            if (saveResult?.error) {
              setPhase('error');
              setError(`Build succeeded but the compiled app couldn't be saved to your files: ${saveResult.error}. Tap RECOMPILE to retry, or download it directly from GitHub below.`);
              notifyComplete('failed', `Artifact save failed: ${saveResult.error}`);
              return;
            }
            // Our own re-uploaded (public) URLs — used instead of GitHub's
            // raw browser_download_url below, which 404s for anyone whose
            // browser isn't authenticated into the private build repo.
            if (saveResult?.artifacts?.length > 0) {
              setStatus((prev) => ({ ...(prev || {}), savedArtifacts: saveResult.artifacts }));
            }
            // Some release assets did not land (e.g. the image failed while a
            // README saved). Name them on screen and in the completion email —
            // before 2026-09-27 this response carried no failures at all, so a
            // glob target read as "Build complete" with the image missing.
            if (saveResult?.partial && saveResult.failed?.length > 0) {
              saveWasPartial = true;
              setSaveFailures(saveResult.failed);
              notifyComplete('partial', `Build finished with ${saveResult.failed.length} compiled file(s) not saved: ${saveResult.failed.join(', ')}`);
            }
          } catch (saveErr) {
            setPhase('error');
            setError(`Build succeeded but saving the artifact failed: ${saveErr?.message || saveErr}. Tap RECOMPILE to retry.`);
            notifyComplete('failed', `Artifact save failed: ${saveErr?.message || saveErr}`);
            return;
          }
          setPhase('done');
          if (!saveWasPartial) notifyComplete('success', 'Build complete');
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

  const handleCompile = async (isAuto = false, isDispatchRetry = false) => {
    if (isAuto) {
      autoLoopRef.current += 1;
      if (autoLoopRef.current > MAX_AUTO_LOOPS) {
        setPhase('error');
        setError(`Auto-fix loop stopped after ${MAX_AUTO_LOOPS} attempts. Review the build logs or ask Morpheus in chat to resolve it.`);
        notifyComplete('failed', `Auto-fix loop stopped after ${MAX_AUTO_LOOPS} attempts`);
        return;
      }
    } else if (!isDispatchRetry) {
      // A fresh manual/redeploy trigger — NOT an automatic dispatch-retry
      // re-invocation of this same function (see below). Only a genuinely
      // new attempt from the user (or the diagnosis "RECOMPILE" button)
      // should reset the dispatch-retry budget; the retry's own recursive
      // call must not reset the counter it's in the middle of spending.
      autoLoopRef.current = 0;
      dispatchRetryRef.current = 0;
      setDispatchRetryAttempt(0);
      notifiedRef.current = false;
    }
    stopRef.current = false;
    startTimeRef.current = Date.now();
    setAttempt(a => a + 1);
    setPhase('compiling');
    setError(null);
    clearDiagnosis();

    // 2026-09-04 (Rob: "can we automate it from compile with that error",
    // then hit the same error again live even after this was first shipped
    // — traced to a wiring bug, see below): dispatch-level failures matching
    // the identified-transient GitHub object-store timing race get one more
    // automatic attempt instead of surfacing straight to the user. Each
    // retry dispatches against a brand-new, timestamped build repo
    // (compileProject.js), so it's a genuinely fresh shot at GitHub's
    // object store, not a repeat of the exact same request. Anything that
    // doesn't match still fails immediately. Returns true if a retry was
    // scheduled (caller should stop, not surface the error).
    const maybeRetryDispatch = (message) => {
      if (TRANSIENT_GITHUB_TIMING_RE.test(message) && dispatchRetryRef.current < MAX_DISPATCH_RETRIES) {
        dispatchRetryRef.current += 1;
        setDispatchRetryAttempt(dispatchRetryRef.current);
        setTimeout(() => handleCompile(false, true), 4000);
        return true;
      }
      return false;
    };

    try {
      const res = await onCompile();
      // Defensive: onCompile normally THROWS on failure (base44Client's
      // apiFetch throws on any non-2xx response, and every compileProject.js
      // error path returns non-2xx — see the catch block below, which is
      // where this error class actually surfaces in practice). This branch
      // only fires if some future handler ever resolves with an `{error}`
      // payload on a 200 instead.
      if (res.error) {
        if (maybeRetryDispatch(res.error)) return;
        setPhase('error');
        setError(res.error);
        notifyComplete('failed', `Compile dispatch failed: ${res.error}`);
        return;
      }
      dispatchRetryRef.current = 0;
      setDispatchRetryAttempt(0);
      setRepoFullName(res.repoFullName);
      setRepoUrl(res.repoUrl);
      setPhase('polling');
      pollStartRef.current = Date.now();
      errorCountRef.current = 0;
      setTimeout(() => poll(res.repoFullName), 3000);
      pollRef.current = setInterval(() => poll(res.repoFullName), 5000);
    } catch (e) {
      // This is the real path for a compileProject dispatch failure —
      // apiFetch throws on the non-2xx response instead of resolving with
      // an `{error}` field, so BadObjectState (and everything else) lands
      // here, not in the `res.error` branch above.
      const message = e.message || String(e);
      if (maybeRetryDispatch(message)) return;
      setPhase('error');
      setError(message);
      notifyComplete('failed', `Compile dispatch failed: ${message}`);
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

  // Publish the compiled build to the user's OWN Netlify account. There is no
  // Morpheus hosting account behind this — if the user has not connected
  // Netlify, the server says exactly that and this shows the sentence verbatim
  // (apiFetch rejects with the server's own message and machine code in
  // err.data, forwarded by functions.routes.js), never a generic failure.
  const handleTakeLive = async () => {
    if (liveInFlight.current) return;
    liveInFlight.current = true;
    setLinkCopied(false);
    setLive({ phase: 'deploying', url: null, error: null, code: null });
    try {
      const res = await base44.functions.invoke('deployFrontend', { projectId: project.id });
      const data = res?.data || {};
      setLive({
        phase: 'live',
        url: data.url || null,
        // Netlify accepted the upload; `pending` says it had not finished processing when
        // the server stopped watching, so the wording below must not claim "live" yet.
        pending: !!data.pending,
        error: data.url ? null : 'Netlify accepted the upload but returned no URL — open app.netlify.com to find the site.',
        code: null,
      });
    } catch (e) {
      setLive({
        phase: 'error',
        url: null,
        error: e?.data?.error || e?.message || String(e),
        code: e?.data?.code || null,
      });
    } finally {
      liveInFlight.current = false;
    }
  };

  const copyLiveUrl = async () => {
    try {
      await navigator.clipboard.writeText(live.url);
      setLinkCopied(true);
    } catch {
      // Clipboard access can be refused (permissions, non-secure context). The
      // link above is still tappable, so this needs no error of its own.
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-lg border border-primary/40 bg-background shadow-[0_0_20px_rgba(0,255,65,0.2)]">
        <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3">
          <div className="flex items-center gap-2">
            <Hammer size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider neon-glow">COMPILE</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-sm text-ink">
            Target: <span className="text-primary uppercase">{target}</span>
          </div>
          {target === 'source' && (
            <p className="text-xs text-ink-strong">
              // Source target doesn't need compilation. Use the ZIP button to download raw source.
            </p>
          )}
          {/* PROVIDER SETUP — the build-time honesty, in the UI.
              The two headings here are the same two sentences the app's README
              carries, both produced server-side by lib/appCapability.js and pinned by
              scripts/verify-app-capability-creds.mjs. The green line is the promise;
              the amber one is the steps. Neither is a fallback for the other. */}
          {provider && provider.mode && provider.mode !== 'none' && (
            <div
              className={`border p-3 space-y-2 ${
                provider.mode === 'connected' ? 'border-primary/40 bg-primary/5' : 'border-yellow-500/40 bg-yellow-500/5'
              }`}
            >
              <div className={`text-xs font-bold ${provider.mode === 'connected' ? 'text-primary' : 'text-yellow-500'}`}>
                {provider.headline}
              </div>
              {provider.mode === 'connected' ? (
                <>
                  <p className="text-xs text-ink-strong">
                    This app goes through your Morpheus Google Drive connection, so there is no OAuth client to
                    create and no origin to register. Keep Google Drive connected in Settings.
                  </p>
                  <p className="text-[11px] text-ink-max">
                    A capability token lets this app write to your Drive, so it must live in the app&apos;s own
                    backend — never in a web page, where anyone opening the app could read it. A static app has
                    nowhere to keep one and takes the own-OAuth-client route instead.
                  </p>
                  {grant?.phase === 'done' ? (
                    <div className="space-y-2 border border-primary/30 p-2">
                      <div className="text-[11px] uppercase tracking-wider text-ink-max">TOKEN FOR THIS APP&apos;S BACKEND — shown once:</div>
                      <div className="font-mono text-[11px] text-ink-max break-all">{grant.token}</div>
                      <button
                        onClick={copyToken}
                        className="w-full flex items-center justify-center gap-2 py-1 border border-primary/40 text-primary/70 hover:border-primary hover:text-primary text-[11px]"
                      >
                        {tokenCopied ? <Check size={12} /> : <Copy size={12} />}
                        {tokenCopied ? 'COPIED' : 'COPY TOKEN'}
                      </button>
                      <p className="text-[11px] text-yellow-500">{grant.warning}</p>
                      {grant.appId && (
                        <p className="text-[11px] text-ink-max">
                          Send it as <span className="font-mono">Authorization: Bearer apc_…</span> to{' '}
                          <span className="font-mono">/api/app-capability</span> with{' '}
                          <span className="font-mono">appId: {grant.appId}</span>.
                        </p>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={createGrant}
                      disabled={grant?.phase === 'creating'}
                      className="w-full flex items-center justify-center gap-2 py-2 border border-primary/40 text-primary/70 hover:border-primary hover:text-primary transition-colors text-xs disabled:opacity-40"
                    >
                      {grant?.phase === 'creating' ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />}
                      APPROVE MY DRIVE FOR THIS APP
                    </button>
                  )}
                  {grant?.phase === 'error' && (
                    <div className="text-[11px] text-red-500 border border-red-500/30 p-2">{grant.error}</div>
                  )}
                </>
              ) : (
                <>
                  {/* The steps, verbatim from the server — the same text the README
                      carries, so a person reading either is told the same thing. */}
                  <pre className="text-[11px] text-ink-max whitespace-pre-wrap font-sans">{provider.message}</pre>
                  <p className="text-[11px] text-ink-max">
                    These steps are in this app&apos;s README too.
                  </p>
                </>
              )}
            </div>
          )}
          {!isSupported && target !== 'source' && (
            <p className="text-xs text-yellow-500/80">
              // Remote compilation not yet supported for this target. Use ZIP export for source.
            </p>
          )}
          {phase === 'idle' && isSupported && (
            <>
              <GithubGate note="Connect your GitHub account so Morpheus can build your binary via GitHub Actions.">
                <button onClick={() => handleCompile(false)} className="w-full flex items-center justify-center gap-2 py-3 border border-primary text-primary hover:bg-primary hover:text-black transition-colors font-bold">
                  <Hammer size={16} /> COMPILE NOW
                </button>
              </GithubGate>
              {target === 'rpi-distro' && (
                <button onClick={() => setShowDistroConfig(true)} className="w-full flex items-center justify-center gap-2 py-2 border border-primary/40 text-primary/70 hover:border-primary hover:text-primary transition-colors text-xs">
                  <Sliders size={14} /> CONFIGURE DISTRO
                </button>
              )}
              {target === 'linux-distro' && (
                <button onClick={() => setShowLinuxDistroConfig(true)} className="w-full flex items-center justify-center gap-2 py-2 border border-primary/40 text-primary/70 hover:border-primary hover:text-primary transition-colors text-xs">
                  <Sliders size={14} /> CONFIGURE DISTRO
                </button>
              )}
              <button onClick={handlePreview} disabled={previewing} className="w-full flex items-center justify-center gap-2 py-2 border border-primary/40 text-primary/70 hover:border-primary hover:text-primary transition-colors text-xs disabled:opacity-40">
                {previewing ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />} PREVIEW BUILD (DRY RUN)
              </button>
              {preview?.error && (
                <div className="text-xs text-red-500 border border-red-500/30 p-2">{preview.error}</div>
              )}
              {preview && !preview.error && (
                <div className="space-y-2 border border-primary/20 bg-background p-3">
                  <div className="text-xs text-ink-strong">// BUILD PREVIEW — {preview.label} on {preview.runner}</div>
                  {preview.validation?.warnings?.length > 0 && (
                    <div className="text-[10px] text-yellow-500/80">
                      {preview.validation.warnings.map((w, i) => <div key={i}>! {w}</div>)}
                    </div>
                  )}
                  {preview.generatedFiles?.length > 0 && (
                    <div>
                      <div className="text-[10px] text-primary/50 mb-1">AUTO-GENERATED FILES ({preview.generatedFiles.length}):</div>
                      <ul className="text-[10px] text-ink-max space-y-0.5">
                        {preview.generatedFiles.map(f => <li key={f} className="font-mono">+ {f}</li>)}
                      </ul>
                    </div>
                  )}
                  <div className="text-[10px] text-ink-max">
                    ARTIFACT: {preview.artifact?.artifactName || preview.artifact?.glob} ({preview.totalFiles} files)
                  </div>
                  <details className="border border-primary/20">
                    <summary className="text-[10px] text-primary/60 cursor-pointer px-2 py-1 hover:text-primary">WORKFLOW YAML (click to expand)</summary>
                    <pre className="text-[9px] text-ink-max overflow-x-auto max-h-48 p-2 scrollbar-matrix whitespace-pre-wrap">{preview.workflow}</pre>
                  </details>
                </div>
              )}
            </>
          )}
          {phase === 'compiling' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1 text-ink text-sm">
                  <Timer size={13} className="text-primary/50" /> <span className="font-mono tabular-nums">{dispatchTimerStr}</span>
                </div>
                {attempt > 1 && <span className="text-[10px] text-primary/50 font-display tracking-wider">ATTEMPT {attempt}</span>}
              </div>
              <div className="text-ink text-sm">
                {dispatchRetryAttempt > 0
                  ? `GitHub is still catching up — retrying automatically (${dispatchRetryAttempt}/${MAX_DISPATCH_RETRIES})...`
                  : (attempt > 1 ? 'Recompiling to test AI fix...' : 'Dispatching build to GitHub Actions...')}
              </div>
              <div className="flex items-start gap-3 border border-primary/20 bg-primary/5 p-3">
                <BigSpinner />
                <HeuristicStepList steps={DISPATCH_STEPS} elapsedSeconds={dispatchElapsed} />
              </div>
            </div>
          )}
          {phase === 'polling' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between border border-primary/20 bg-primary/5 px-3 py-2">
                <div className="flex items-center gap-3 text-ink font-mono text-sm">
                  <span className="flex items-center gap-1"><Timer size={14} /> {timerStr}</span>
                  {etaStr && <span className="text-primary/60 text-xs">ETA {etaStr}</span>}
                </div>
                <button onClick={handleStop} className="flex items-center gap-1 text-xs text-black bg-red-500 hover:bg-red-400 px-3 py-1 font-bold">
                  <Square size={12} /> STOP
                </button>
              </div>
              <div className="flex items-start gap-3 border border-primary/20 bg-primary/5 p-3">
                <BigSpinner />
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-ink text-sm">{status?.message || 'Build queued...'}</div>
                    {attempt > 1 && <span className="text-[10px] text-primary/50 font-display tracking-wider shrink-0 ml-2">ATTEMPT {attempt}</span>}
                  </div>
                  {status?.stepProgress && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-ink-strong">
                        <span className="font-mono">STEP {status.stepProgress.completed}/{status.stepProgress.total}</span>
                        <span className="text-ink-strong truncate ml-2 text-right">{status.stepProgress.currentStep}</span>
                      </div>
                      <div className="h-1.5 bg-primary/10 border border-primary/20 overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all duration-500"
                          style={{ width: `${status.stepProgress.total > 0 ? (status.stepProgress.completed / status.stepProgress.total) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {errorCountRef.current > 0 && (
                <p className="text-xs text-yellow-500/80">
                  // Status check retrying ({errorCountRef.current}/{MAX_ERRORS}) — GitHub may be indexing the workflow...
                </p>
              )}
              {repoUrl && (
                <a href={repoUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary/50 hover:text-primary">
                  <ExternalLink size={12} /> View repo on GitHub
                </a>
              )}
            </div>
          )}
          {phase === 'saving' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-ink text-sm">
                <Loader2 size={16} className="animate-spin" /> Saving compiled app to your files...
              </div>
              <p className="text-xs text-ink-strong">
                // Downloading the binary from GitHub and storing it under _compiled/. This takes a few seconds — don't close this panel.
              </p>
            </div>
          )}
          {/* The live card has to be reachable WITHOUT a compile in this session, so this
              wrapper opens for a hydrated live state too and the build-report half below
              stays gated on `phase === 'done'`. Before this, a user who reloaded the page
              (or reopened the panel) saw nothing about a site that is live — the record
              existed and the UI simply could not reach it. */}
          {(phase === 'done' || live.phase === 'live') && (
            <div className="space-y-3">
              {phase === 'done' && (saveFailures.length > 0 ? (
                <>
                  <div className="flex items-center gap-2 text-yellow-500 text-sm">
                    <AlertTriangle size={16} /> BUILD FINISHED — {saveFailures.length} COMPILED FILE{saveFailures.length === 1 ? '' : 'S'} DID NOT SAVE
                  </div>
                  <p className="text-xs text-ink-strong">
                    // The build succeeded, but these compiled files did not land and are not in your file tree:
                  </p>
                  <ul className="space-y-0.5 pl-4 list-disc text-xs text-ink-strong font-mono">
                    {saveFailures.map((name) => <li key={name}>{name}</li>)}
                  </ul>
                  <p className="text-xs text-ink-strong">
                    // Everything that did save is available below. Tap RECOMPILE to retry the missing files.
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-ink text-sm">
                    <CheckCircle size={16} /> Build complete!
                  </div>
                  <p className="text-xs text-ink-strong">
                    // Compiled package saved to your file tree under _compiled/. Switch to the FILES tab to download.
                  </p>
                </>
              ))}
              {/* 2026-09-28 — the gap this closes: Morpheus could build a web app
                  and could not host it. This publishes the compiled build to the
                  user's OWN Netlify account (their token, their site) and shows
                  the URL. web-app only: no other target produces a static build
                  to host, and the server refuses the rest by name. */}
              {target === 'web-app' && (
                <div className="border border-primary/30 bg-primary/5 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-ink text-sm">
                    <Rocket size={14} className="text-primary" />
                    {live.phase === 'live'
                      ? (live.pending ? 'PUBLISHED — NETLIFY IS FINISHING' : 'YOUR SITE IS LIVE')
                      : 'TAKE IT LIVE'}
                  </div>

                  {live.phase === 'live' && live.url ? (
                    <>
                      <p className="text-xs text-ink-strong">
                        // Published to your own Netlify account — no Morpheus hosting involved. Share this URL:
                      </p>
                      <a href={live.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 py-2 px-3 border border-primary/40 hover:border-primary hover:bg-primary/10 transition-colors text-sm text-ink break-all">
                        <ExternalLink size={14} className="text-primary shrink-0" /> <span className="font-mono">{live.url}</span>
                      </a>
                      <div className="flex items-center gap-2">
                        <button onClick={copyLiveUrl} className="flex items-center gap-1.5 px-3 py-1.5 border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-xs">
                          {linkCopied ? <Check size={12} /> : <Copy size={12} />} {linkCopied ? 'COPIED' : 'COPY LINK'}
                        </button>
                        <button onClick={handleTakeLive} disabled={liveBusy} className="flex items-center gap-1.5 px-3 py-1.5 border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-xs disabled:opacity-40">
                          {liveBusy ? <Loader2 size={12} className="animate-spin" /> : <Rocket size={12} />} RE-DEPLOY
                        </button>
                      </div>
                      {liveBusy && <p className="text-[11px] text-ink-max">Publishing the new build to your Netlify — wait for it to finish, don&apos;t close this panel.</p>}
                      {/* Read back from the deploy record, not remembered by this panel. Both lines
                          exist so a live site is never described as either newer or more complete than
                          it is: "live and behind your latest changes" and "live but the build is gone"
                          are different facts, and the button says RE-DEPLOY for both. */}
                      {!liveBusy && live.pending && (
                        <p className="text-[11px] text-ink-max">
                          Netlify has your build and is still finishing. The address may take a few seconds to serve it.
                        </p>
                      )}
                      {!liveBusy && live.stale && (
                        <p className="text-[11px] text-ink-max">
                          This is the build you published. You have changed the construct since — RE-DEPLOY puts the newer build live.
                        </p>
                      )}
                      {!liveBusy && live.noArtifact && (
                        <p className="text-[11px] text-ink-max">
                          The compiled package is no longer in this construct, so a re-deploy needs a fresh COMPILE first.
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-ink-strong">
                        // Publish this build to your own Netlify account and get a working URL (something.netlify.app). Your token, your site.
                      </p>
                      <button onClick={handleTakeLive} disabled={liveBusy} className="flex items-center gap-2 w-full justify-center py-2.5 border border-primary text-primary hover:bg-primary hover:text-black transition-colors text-sm font-bold disabled:opacity-40">
                        {liveBusy ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />} {liveBusy ? 'PUBLISHING TO YOUR NETLIFY…' : 'TAKE IT LIVE'}
                      </button>
                      {liveBusy && <p className="text-[11px] text-ink-max">Publishing — wait for it to finish, don&apos;t close this panel.</p>}
                      {live.phase === 'error' && live.error && (
                        <div className="text-xs text-red-500 border border-red-500/30 p-2 space-y-2">
                          <p>{live.error}</p>
                          {live.code === 'BACKEND_NOT_DEPLOYED' && onBuildBackend && (
                            <button onClick={onBuildBackend} className="flex items-center gap-1.5 px-3 py-1.5 border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-xs">
                              <Server size={12} /> BUILD &amp; DEPLOY BACKEND
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              {status?.assets?.length === 0 && (
                <p className="text-xs text-yellow-500/80">
                  // Build succeeded but published no downloadable artifact. Check the release on GitHub.
                </p>
              )}
              {/* Prefer our own re-uploaded copy (storage.js) — always a public
                  URL. GitHub's asset browser_download_url (used as a fallback
                  below) lives in a private build repo and 404s in the browser
                  unless it happens to be signed into a GitHub account with
                  access to that specific repo, so it's not a reliable primary
                  link. */}
              {status?.savedArtifacts?.length > 0
                ? status.savedArtifacts.map((a, i) => (
                    <a key={i} href={a.url} download={a.name} target="_blank" rel="noreferrer" className="flex items-center gap-2 py-2 px-3 border border-primary/40 hover:border-primary hover:bg-primary/10 transition-colors text-sm">
                      <Download size={14} /> {a.name}{a.size ? ` (${(a.size / 1024 / 1024).toFixed(1)} MB)` : ''}
                    </a>
                  ))
                : status?.assets?.map((a, i) => (
                    <a key={i} href={a.downloadUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 py-2 px-3 border border-primary/40 hover:border-primary hover:bg-primary/10 transition-colors text-sm">
                      <Download size={14} /> {a.name} ({(a.size / 1024 / 1024).toFixed(1)} MB)
                    </a>
                  ))}
              {status?.releaseUrl && (
                <a href={status.releaseUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary/50 hover:text-primary">
                  <ExternalLink size={12} /> View release on GitHub (requires GitHub access)
                </a>
              )}
              {(target === 'rpi-distro' || target === 'linux-distro') && (
                <div className="border border-primary/30 bg-primary/5 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-ink text-sm">
                    <Wifi size={14} /> {target === 'rpi-distro' ? 'Write to a Pi over the network' : 'Write to a server over the network'}
                  </div>
                  <p className="text-xs text-ink-strong">
                    // Enter your Pi's SSH details and Morpheus builds a command that pulls the image from storage and writes it to the device — no SD card swapping.
                  </p>
                  <button onClick={() => setShowNetFlash(true)} className="flex items-center gap-2 w-full justify-center py-2.5 border border-primary text-primary hover:bg-primary hover:text-black transition-colors text-sm font-bold">
                    <Wifi size={14} /> TRANSFER OVER NETWORK
                  </button>
                </div>
              )}
              {onBuildBackend && (
                <div className="border border-primary/30 bg-primary/5 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-ink text-sm">
                    <Server size={14} /> Does your app need a backend?
                  </div>
                  <p className="text-xs text-ink-strong">
                    // Congrats on the compile! If your app needs a server, database, or API, Morpheus can auto-generate and deploy one now.
                  </p>
                  <button onClick={onBuildBackend} className="flex items-center gap-2 w-full justify-center py-2.5 border border-primary text-primary hover:bg-primary hover:text-black transition-colors text-sm font-bold">
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
                  <span className="text-[10px] text-primary/50 font-display tracking-wider">ATTEMPT {attempt}</span>
                )}
              </div>

              {/* Fix-loop guide — gives people the mental model so the
                  iterative diagnose → fix → recompile cycle isn't a mystery. */}
              <div className="border border-primary/20 bg-primary/5 p-2.5 text-xs text-ink-strong space-y-0.5">
                <p className="text-primary/80 font-bold uppercase tracking-wider text-[10px] flex items-center gap-1">
                  <RefreshCw size={10} className="animate-spin" /> FIX LOOP <span className="text-ink-max normal-case tracking-normal font-normal">// runs automatically</span>
                </p>
                <p>// 1. AI reads the build logs and auto-fixes what it can.</p>
                <p>// 2. Morpheus recompiles to test the fix — no action needed.</p>
                <p>// 3. Fails again? It loops again. Stops only when stuck or you hit STOP.</p>
                <p className="text-ink-strong pt-0.5">// Each fix is saved to your files — you never lose progress.</p>
              </div>

              {error && error !== 'Build failed. Fetching logs and diagnosing...' && (
                <p className="text-xs text-red-500/80">{error}</p>
              )}

              {status?.assets?.length > 0 && (
                <div className="space-y-1.5 border border-primary/30 bg-primary/5 p-2">
                  <div className="text-xs text-ink-strong">// DIRECT DOWNLOADS (from GitHub — requires access)</div>
                  {status.assets.map((a, i) => (
                    <a key={i} href={a.downloadUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 py-1.5 px-3 border border-primary/40 hover:border-primary hover:bg-primary/10 transition-colors text-sm">
                      <Download size={14} /> {a.name} ({(a.size / 1024 / 1024).toFixed(1)} MB)
                    </a>
                  ))}
                </div>
              )}

              {status?.logs?.length > 0 && (
                <details className="border border-primary/20 bg-background">
                  <summary className="text-xs text-primary/60 cursor-pointer px-3 py-1.5 hover:text-primary">BUILD LOGS (click to expand)</summary>
                  <pre className="text-[10px] text-ink-max overflow-x-auto max-h-48 p-3 scrollbar-matrix whitespace-pre-wrap">{status.logs.map(l => `=== ${l.job} ===\n${l.log}`).join('\n\n')}</pre>
                </details>
              )}
              {repoUrl && (
                <a href={repoUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary/50 hover:text-primary">
                  <ExternalLink size={12} /> Check run logs on GitHub
                </a>
              )}

              {!diagnosis && !diagnosing && (
                <button onClick={diagnoseCompile} disabled={diagnosing} className="flex items-center gap-1 text-xs text-primary hover:text-primary px-3 py-2 border border-primary/50 hover:border-primary disabled:opacity-30 w-fit">
                  {diagnosing ? <Loader2 size={12} className="animate-spin" /> : <Bot size={12} />} AI DIAGNOSE & FIX
                </button>
              )}
              {diagnosing && <DiagnosisLoading label="AI AGENT ANALYZING BUILD ERRORS..." steps={COMPILE_DIAGNOSIS_STEPS} />}
              {diagnosis && !diagnosing && (
                <>
                  <DiagnosisPanel diagnosis={diagnosis} onRedeploy={() => handleCompile(false)} redeployLabel="RECOMPILE" onAskMorpheus={() => onAskMorpheus?.(diagnosis)} />
                  {diagnosis.needsUserAction?.length > 0 && !diagnosis.autoFixed?.length && (
                    <p className="text-[10px] text-ink-max leading-relaxed">
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
                <a href={repoUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary/50 hover:text-primary">
                  <ExternalLink size={12} /> Cancel the run on GitHub
                </a>
              )}
              <button onClick={reset} className="flex items-center gap-1 text-xs text-primary px-3 py-2 border border-primary/50 hover:border-primary w-fit">
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