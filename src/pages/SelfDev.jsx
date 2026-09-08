// Admin-only workspace: lets Rob use Morpheus itself — the same chat, file
// editor, and live preview it gives every user — to iteratively develop
// Morpheus's own codebase. Reuses useWorkspace()/ChatPanel/FileTree/
// FileViewer/PreviewPanel exactly as Workspace.jsx does; the only things
// specific to self-dev are: (1) it always operates on one singleton
// project_type:'self_dev' Project instead of a picker, (2) a SYNC FROM
// GITHUB action that pulls the real morpheus-self-hosted repo's current
// files in (importSelfDevRepo), (3) a PUSH TO PRODUCTION action that pushes
// straight to that same real repo/branch (pushSelfDevToGithub) — which is
// what Northflank/Netlify's existing git-based auto-deploy actually watches,
// so this one push is what ships a change live, and (4) chat messages carry
// the pinned/open files' paths as focusPaths (contextPaths below — opening a
// file pins it, and multiple files can be pinned at once via the FileTree
// checkboxes) so chatWithMorpheus.js can scope its context instead of
// sending the whole repo every turn.
//
// Nothing here ever pushes automatically — chatting and editing only ever
// touches this project's local ProjectFile rows. Only the explicit PUSH
// button (behind its own confirmation) reaches the real repo.
import { useState, useEffect, useCallback, useRef } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { base44 } from '@/api/base44Client';
import { Cpu, RefreshCw, Rocket, Home as HomeIcon, AlertTriangle, Loader2, CheckCircle2, XCircle, X, Stethoscope, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import ChatPanel from '@/components/matrix/ChatPanel';
import FileTree from '@/components/matrix/FileTree';
import FileViewer from '@/components/matrix/FileViewer';
import PreviewPanel from '@/components/matrix/PreviewPanel';
import SelfDevHistoryModal from '@/components/matrix/SelfDevHistoryModal';
import MatrixRain from '@/components/matrix/MatrixRain';
import HelpToggle from '@/components/matrix/HelpToggle';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { useIsMobile } from '@/hooks/use-mobile';

const btnBase = "flex items-center gap-1.5 text-xs px-3 h-[36px] whitespace-nowrap shrink-0 border transition-colors";

export default function SelfDev() {
  const ws = useWorkspace();
  const isMobile = useIsMobile();
  const [initializing, setInitializing] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [showPushConfirm, setShowPushConfirm] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);
  // Secondary toolbar actions collapse into a MORE row — expanded by default
  // on desktop, tucked away on mobile where they used to scroll off the
  // right edge (Command Deck 4.0 #3). useIsMobile() is false on first paint,
  // so read the width directly for the initial state.
  const [toolbarOpen, setToolbarOpen] = useState(() => {
    try { return window.innerWidth >= 768; } catch { return true; }
  });
  const [showHistory, setShowHistory] = useState(false);
  const [mobileTab, setMobileTab] = useState('chat');
  const [diagnosing, setDiagnosing] = useState(false);
  // Post-push deploy watcher (#4). phase: 'building' | 'deployed' | 'failed'
  // | 'timeout' | 'notConfigured'.
  const [deployWatch, setDeployWatch] = useState(null);
  // The last push's commit, kept in localStorage so REVERT LAST PUSH (#3)
  // survives a reload. { commitSha, commitUrl, at }.
  const [lastPush, setLastPush] = useState(null);
  const [reverting, setReverting] = useState(false);
  const [revertResult, setRevertResult] = useState(null);
  const didInit = useRef(false);
  const autoDiagnosedFor = useRef(null);

  // AI context pinning (2026-09-02) — chatWithMorpheus.js's self-dev safety
  // rule refuses to blindly "update" any file whose content it hasn't been
  // shown (see focusPaths / buildSelfDevContext), which used to mean only
  // ever the single currently-open file: any change touching two+ existing
  // files (i.e. almost any real feature addition) required opening one file,
  // asking, opening the next, asking again. Now the operator can pin several
  // files at once (checkboxes in FileTree) and every message sends all of
  // them as focusPaths, so the AI can see and safely edit all of them in one
  // turn. Opening a file also pins it automatically, matching the old
  // behavior as the default case.
  const [contextPaths, setContextPaths] = useState(() => new Set());
  const toggleContext = useCallback((path) => {
    setContextPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const openFile = useCallback((f) => {
    ws.setSelectedFile(f);
  }, [ws]);

  const syncFromGithub = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await base44.functions.invoke('importSelfDevRepo', {});
      const project = await base44.entities.Project.get(res.data.projectId);
      await ws.selectProject(project);
      setSyncResult({ ok: true, ...res.data });
      return project;
    } catch (e) {
      setSyncResult({ ok: false, error: e.message });
      return null;
    } finally {
      setSyncing(false);
    }
  }, [ws]);

  // One-time boot: find the existing self-dev project, or create it by
  // syncing from GitHub for the first time.
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    (async () => {
      try {
        const all = await base44.entities.Project.list('-created_date', 50);
        const existing = all.find((p) => p.project_type === 'self_dev');
        if (existing) {
          await ws.selectProject(existing);
        } else {
          await syncFromGithub();
        }
      } finally {
        setInitializing(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore the last-push marker (for REVERT LAST PUSH) once the project is
  // known — keep it for 24h.
  useEffect(() => {
    if (!ws.currentProject?.id) return;
    try {
      const raw = localStorage.getItem(`morpheus_selfdev_lastpush_${ws.currentProject.id}`);
      const parsed = raw ? JSON.parse(raw) : null;
      setLastPush(parsed && Date.now() - parsed.at < 24 * 3600 * 1000 ? parsed : null);
    } catch { setLastPush(null); }
  }, [ws.currentProject?.id]);

  // #4 — deploy watcher. Polls Northflank after a push; on a failed
  // build/deployment it flips the banner to 'failed' and fires
  // autoDiagnoseDeploy once.
  useEffect(() => {
    const sha = pushResult?.ok ? pushResult.commitSha : null;
    if (!sha) return;
    let cancelled = false;
    let attempts = 0;
    setDeployWatch({ phase: 'building' });
    const poll = async () => {
      if (cancelled) return;
      if (attempts++ > 45) { setDeployWatch((w) => (w?.phase === 'building' ? { ...w, phase: 'timeout' } : w)); return; }
      try {
        const res = await base44.admin.getNorthflankStatus();
        if (cancelled) return;
        if (res.configured === false) { setDeployWatch({ phase: 'notConfigured' }); return; }
        const build = res.service?.status?.build?.status;
        const deploy = res.service?.status?.deployment?.status;
        const failed = /FAIL|ERROR|CANCEL/i.test(build || '') || /FAIL|ERROR|CRASH|BACKOFF/i.test(deploy || '');
        const buildOk = /SUCCESS|SUCCESSFUL|COMPLETE|DONE/i.test(build || '');
        const deployOk = /RUNNING|DEPLOYED|SUCCESS|COMPLETE|HEALTHY/i.test(deploy || '');
        if (failed) {
          setDeployWatch({ phase: 'failed', build, deploy });
          if (autoDiagnosedFor.current !== sha) { autoDiagnosedFor.current = sha; autoDiagnoseDeploy(build, deploy); }
          return;
        }
        if (buildOk && deployOk) { setDeployWatch({ phase: 'deployed', build, deploy }); return; }
        setDeployWatch({ phase: 'building', build, deploy });
        setTimeout(poll, 20000);
      } catch {
        if (!cancelled) setTimeout(poll, 20000); // transient — keep trying
      }
    };
    const t = setTimeout(poll, 15000);
    return () => { cancelled = true; clearTimeout(t); };
  }, [pushResult?.commitSha]); // eslint-disable-line react-hooks/exhaustive-deps

  const runVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const { data } = await base44.functions.invoke('verifySelfDev', {});
      setVerifyResult(data);
      return data;
    } catch (e) {
      setVerifyResult({ ok: false, error: e?.response?.data?.error || e.message, errors: [] });
      return null;
    } finally {
      setVerifying(false);
    }
  };

  const handleSend = (text, fileUrls) => {
    const pinned = Array.from(contextPaths);
    ws.sendMessage(text, fileUrls, false, pinned);
  };

  const rememberLastPush = (data, projectId) => {
    const entry = { commitSha: data.commitSha, commitUrl: data.commitUrl, at: Date.now() };
    setLastPush(entry);
    try { localStorage.setItem(`morpheus_selfdev_lastpush_${projectId}`, JSON.stringify(entry)); } catch { /* storage off */ }
  };

  const doPush = async (force = false) => {
    setPushing(true);
    try {
      const res = await base44.functions.invoke('pushSelfDevToGithub', { projectId: ws.currentProject.id, force });
      if (res.data?.blocked) {
        setVerifyResult(res.data.verify);
        setPushResult({ ok: false, error: res.data.message });
        return;
      }
      setPushResult({ ok: true, ...res.data });
      setVerifyResult(null);
      setDeployWatch(null);
      setRevertResult(null);
      // Northflank (backend) and Netlify (frontend) auto-build from this
      // push. The deploy watcher effect (keyed on pushResult.commitSha)
      // polls Northflank and, on a failed build/deploy, auto-pulls the logs
      // into a fix turn — see below.
      if (res.data?.commitSha) rememberLastPush(res.data, ws.currentProject.id);
    } catch (e) {
      setPushResult({ ok: false, error: e.message });
    } finally {
      setPushing(false);
      setShowPushConfirm(false);
    }
  };

  // #4 — when a deploy fails, pull build + runtime error logs and open a fix
  // turn automatically. Reuses the normal chat/edit/review flow: the AI
  // still only edits this local workspace; shipping the fix is still a
  // deliberate PUSH.
  const autoDiagnoseDeploy = async (build, deploy) => {
    try {
      const [b, r] = await Promise.all([
        base44.admin.getNorthflankLogs({ search: 'error', minutes: 30, limit: 80, type: 'build' }),
        base44.admin.getNorthflankLogs({ search: 'error', minutes: 30, limit: 60, type: 'runtime' }),
      ]);
      const fmt = (x) => (x.lines || []).map((l) => `${l.ts || ''} ${l.log}`).join('\n') || '(no matching lines)';
      handleSend(
        `⚠️ THE PUSH YOU JUST MADE FAILED TO DEPLOY. Northflank build=${build || '?'} deployment=${deploy || '?'}. Production is on a broken deploy — treat this as urgent.\n\nBUILD LOGS (errors, last 30 min):\n${fmt(b)}\n\nRUNTIME LOGS (errors, last 30 min):\n${fmt(r)}\n\nDiagnose the root cause and fix it in the code. If it can't be fixed quickly, say so plainly so I can REVERT LAST PUSH instead.`,
        [],
      );
    } catch {
      /* logs unavailable — the failed banner + REVERT button still show */
    }
  };

  const doRevert = async () => {
    if (!lastPush?.commitSha) return;
    setReverting(true);
    setRevertResult(null);
    try {
      const { data } = await base44.functions.invoke('revertSelfDevPush', { commitSha: lastPush.commitSha });
      setRevertResult({ ok: true, ...data });
      setDeployWatch(null);
      setLastPush(null);
      try { localStorage.removeItem(`morpheus_selfdev_lastpush_${ws.currentProject.id}`); } catch { /* */ }
    } catch (e) {
      setRevertResult({ ok: false, error: e?.response?.data?.error || e.message });
    } finally {
      setReverting(false);
    }
  };

  // Ops Console companion (2026-09-02) — pulls recent production error logs
  // straight from Northflank (server/src/lib/northflank.js, via the Admin
  // Panel's same Ops Console endpoints) and drops them into the self-dev
  // chat as a normal message. Deliberately reuses the existing chat/edit/
  // review flow rather than a separate "auto-fix" pipeline: the AI still
  // only ever edits this local workspace, and PUSH TO PRODUCTION is still
  // the one and only thing that ships anything — matches Rob's explicit
  // call (2026-09-02) that diagnosed fixes always stop for review, never
  // auto-push.
  const diagnoseFromLogs = async () => {
    setDiagnosing(true);
    try {
      const res = await base44.admin.getNorthflankLogs({ search: 'error', minutes: 60, limit: 60, type: 'runtime' });
      if (res.configured === false) {
        alert('Northflank not configured — set NORTHFLANK_API_TOKEN. See Admin Panel → Ops Console for setup instructions.');
        return;
      }
      if (res.error) {
        alert(`Couldn't pull logs: ${res.error}`);
        return;
      }
      const lines = res.lines || [];
      const logBlock = lines.length
        ? lines.map((l) => `${l.ts || ''} ${l.log}`).join('\n')
        : '(no log lines matching "error" in the last 60 minutes)';
      handleSend(
        `Production logs (Northflank, last 60 min, filtered for "error"):\n\n${logBlock}\n\nDiagnose the root cause and fix it in the code. Explain what was wrong before making the change.`,
        []
      );
    } catch (e) {
      alert(`Couldn't pull logs: ${e.message}`);
    } finally {
      setDiagnosing(false);
    }
  };

  if (initializing || !ws.currentProject) {
    return (
      <div className="relative min-h-screen bg-background text-primary font-mono flex items-center justify-center">
        <MatrixRain opacity={0.05} />
        <div className="relative z-10 flex flex-col items-center gap-3">
          <Loader2 size={28} className="animate-spin text-primary/60" />
          <p className="text-primary/60 text-sm">// {syncing ? 'Syncing morpheus-self-hosted…' : 'Loading self-dev workspace…'}</p>
          {syncResult?.ok === false && <p className="text-red-500 text-xs max-w-md text-center">{syncResult.error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-workspace-mobile bg-background text-primary font-mono flex flex-col overflow-hidden safe-top">
      <div className="flex flex-col border-b border-primary/20 bg-background shrink-0">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-3 min-w-0">
            <Cpu size={18} className="text-primary shrink-0" />
            <span className="text-primary font-display tracking-wider truncate neon-glow">MORPHEUS SELF-DEV</span>
            <span className="hidden sm:inline text-xs text-primary/75 uppercase border border-primary/30 px-2 py-0.5 shrink-0">{ws.currentProject.status}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setShowPushConfirm(true)} disabled={pushing} className={`${btnBase} text-black bg-primary hover:bg-primary/90 border-primary font-bold disabled:opacity-50`}>
              <Rocket size={13} /> <span className="hidden sm:inline">PUSH TO PRODUCTION</span><span className="sm:hidden">PUSH</span>
            </button>
            <button
              onClick={() => setToolbarOpen((o) => !o)}
              aria-expanded={toolbarOpen}
              aria-label={toolbarOpen ? 'Hide actions' : 'Show actions'}
              className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60 hover:bg-primary/5`}
            >
              {toolbarOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              <span className="hidden sm:inline">{toolbarOpen ? 'LESS' : 'MORE'}</span>
            </button>
          </div>
        </div>
        {toolbarOpen && (
          <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5 pt-2 border-t border-primary/10">
            <button onClick={() => setShowHistory(true)} className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60 hover:bg-primary/5`}>
              HISTORY
            </button>
            <button onClick={syncFromGithub} disabled={syncing} className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60 hover:bg-primary/5 disabled:opacity-50`}>
              <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'SYNCING…' : 'SYNC FROM GITHUB'}
            </button>
            <button onClick={runVerify} disabled={verifying || pushing} title="Run esbuild syntax + import/export checks across the whole workspace — the same gate that runs before a push" className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60 hover:bg-primary/5 disabled:opacity-50`}>
              <ShieldCheck size={13} className={verifying ? 'animate-pulse' : ''} /> {verifying ? 'VERIFYING…' : 'VERIFY'}
            </button>
            <button onClick={diagnoseFromLogs} disabled={diagnosing || ws.loading} title="Pull recent production error logs from Northflank and ask the AI to diagnose + fix them" className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60 hover:bg-primary/5 disabled:opacity-50`}>
              <Stethoscope size={13} className={diagnosing ? 'animate-pulse' : ''} /> {diagnosing ? 'PULLING LOGS…' : 'DIAGNOSE FROM LOGS'}
            </button>
            <HelpToggle />
            <Link to="/admin" title="Admin Control Panel — model routing, config, ops console (DB console, Northflank logs), audit log" className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60 hover:bg-primary/5`}>
              <ShieldCheck size={13} /> ADMIN
            </Link>
            <Link to="/" className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60 hover:bg-primary/5`}>
              <HomeIcon size={13} /> <span className="sm:hidden">HOME</span>
            </Link>
          </div>
        )}
        <div className="flex items-start gap-2 border-t border-yellow-500/30 bg-yellow-500/10 px-4 py-1.5">
          <AlertTriangle size={12} className="text-yellow-500 shrink-0 mt-0.5" />
          <span className="text-yellow-500/80 text-[11px] font-mono leading-tight">
            This edits Morpheus's real source. Chat and file edits only change this local workspace — nothing reaches GitHub or production until you click PUSH TO PRODUCTION.
          </span>
        </div>
        {syncResult?.ok && (
          <div className="flex items-center gap-2 border-t border-primary/20 bg-primary/5 px-4 py-1 text-[11px] text-primary/60">
            <CheckCircle2 size={11} /> Synced {syncResult.fileCount} files from {syncResult.repoFullName}@{syncResult.branch}
            {syncResult.removed > 0 ? ` (${syncResult.removed} removed locally)` : ''}.
          </div>
        )}
        {verifyResult && (
          <div className={`border-t px-4 py-1.5 text-[11px] ${verifyResult.ok ? 'border-primary/20 bg-primary/5 text-primary/70' : 'border-red-500/30 bg-red-500/10 text-red-400'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                {verifyResult.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                {verifyResult.error
                  ? `Verify failed to run: ${verifyResult.error}`
                  : verifyResult.ok
                    ? `Verified — ${verifyResult.checkedFiles} files, no syntax or import errors.`
                    : `Verification: ${verifyResult.errorCount} error(s) — fix before pushing.`}
              </span>
              <button onClick={() => setVerifyResult(null)} className="text-primary/50 hover:text-primary shrink-0"><X size={12} /></button>
            </div>
            {verifyResult.errors?.length > 0 && (
              <ul className="mt-1 space-y-0.5 font-mono max-h-40 overflow-y-auto scrollbar-matrix">
                {verifyResult.errors.map((e, i) => (
                  <li key={i} className="truncate">
                    <span className="text-red-400/70">[{e.phase}]</span> {e.file}{e.line ? `:${e.line}` : ''} — {e.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {pushResult && (
          <div className={`flex items-center justify-between gap-2 border-t px-4 py-1.5 text-[11px] ${pushResult.ok ? 'border-primary/20 bg-primary/5 text-primary/70' : 'border-red-500/30 bg-red-500/10 text-red-400'}`}>
            <span className="flex items-center gap-2">
              {pushResult.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
              {pushResult.ok
                ? (pushResult.commitUrl
                    ? <>Pushed to production: {[pushResult.createCount && `${pushResult.createCount} new`, pushResult.updateCount && `${pushResult.updateCount} changed`, pushResult.deleteCount && `${pushResult.deleteCount} deleted`].filter(Boolean).join(', ') || `${pushResult.fileCount} file(s)`} — <a href={pushResult.commitUrl} target="_blank" rel="noreferrer" className="underline hover:text-primary">view commit</a></>
                    : (pushResult.message || 'No changes to push.'))
                : `Push failed: ${pushResult.error}`}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              {!pushResult.ok && verifyResult && !verifyResult.ok && (
                <button onClick={() => doPush(true)} disabled={pushing} className="text-[10px] text-yellow-500/90 border border-yellow-500/40 px-2 py-0.5 hover:bg-yellow-500/10 disabled:opacity-40">
                  PUSH ANYWAY
                </button>
              )}
              <button onClick={() => setPushResult(null)} className="text-primary/50 hover:text-primary shrink-0"><X size={12} /></button>
            </div>
          </div>
        )}
        {deployWatch && (
          <div className={`flex items-center justify-between gap-2 border-t px-4 py-1.5 text-[11px] ${deployWatch.phase === 'failed' ? 'border-red-500/30 bg-red-500/10 text-red-400' : deployWatch.phase === 'deployed' ? 'border-primary/20 bg-primary/5 text-primary/70' : 'border-primary/15 bg-primary/5 text-primary/60'}`}>
            <span className="flex items-center gap-2">
              {deployWatch.phase === 'building' && <><Loader2 size={11} className="animate-spin" /> Deploying — Northflank build {deployWatch.build || '…'}{deployWatch.deploy ? `, deployment ${deployWatch.deploy}` : ''}</>}
              {deployWatch.phase === 'deployed' && <><CheckCircle2 size={11} /> Deployed — production is live on this push.</>}
              {deployWatch.phase === 'failed' && <><XCircle size={11} /> Deploy FAILED (build {deployWatch.build || '?'} / deployment {deployWatch.deploy || '?'}) — pulled the logs into chat. Fix it or REVERT.</>}
              {deployWatch.phase === 'timeout' && <>Deploy status still pending after 15 min — check <Link to="/admin" className="underline hover:text-primary">Admin → Ops Console</Link>.</>}
              {deployWatch.phase === 'notConfigured' && <>Deploy watch off (no NORTHFLANK_API_TOKEN) — Northflank/Netlify still deploy from the push.</>}
            </span>
            <button onClick={() => setDeployWatch(null)} className="text-primary/50 hover:text-primary shrink-0"><X size={12} /></button>
          </div>
        )}
        {(lastPush || deployWatch?.phase === 'failed') && !revertResult && (
          <div className="flex items-center justify-between gap-2 border-t border-yellow-500/20 bg-yellow-500/5 px-4 py-1.5 text-[11px] text-primary/60">
            <span>// Last push {lastPush?.commitSha ? lastPush.commitSha.slice(0, 7) : ''} can be rolled back — one commit, production redeploys to the pre-push state.</span>
            <button onClick={doRevert} disabled={reverting || !lastPush?.commitSha} className="text-[10px] text-yellow-500/90 border border-yellow-500/40 px-2 py-0.5 hover:bg-yellow-500/10 disabled:opacity-40 shrink-0 flex items-center gap-1">
              {reverting ? <Loader2 size={10} className="animate-spin" /> : null} REVERT LAST PUSH
            </button>
          </div>
        )}
        {revertResult && (
          <div className={`flex items-center justify-between gap-2 border-t px-4 py-1.5 text-[11px] ${revertResult.ok ? 'border-primary/20 bg-primary/5 text-primary/70' : 'border-red-500/30 bg-red-500/10 text-red-400'}`}>
            <span className="flex items-center gap-2">
              {revertResult.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
              {revertResult.ok
                ? <>Reverted — production rolling back to {revertResult.revertedToSha?.slice(0, 7)}. <a href={revertResult.commitUrl} target="_blank" rel="noreferrer" className="underline hover:text-primary">revert commit</a></>
                : `Revert failed: ${revertResult.error}`}
            </span>
            <button onClick={() => setRevertResult(null)} className="text-primary/50 hover:text-primary shrink-0"><X size={12} /></button>
          </div>
        )}
        {contextPaths.size > 0 && (
          <div className="flex items-start gap-2 border-t border-primary/20 bg-primary/5 px-4 py-1.5 text-[11px] text-primary/70 flex-wrap">
            <span className="uppercase tracking-wider text-primary/50 shrink-0 mt-0.5">AI context ({contextPaths.size}):</span>
            {Array.from(contextPaths).map((p) => (
              <span key={p} className="flex items-center gap-1 border border-primary/25 px-1.5 py-0.5">
                <span className="truncate max-w-[220px]">{p}</span>
                <button onClick={() => toggleContext(p)} className="text-primary/50 hover:text-red-400 shrink-0" aria-label={`Remove ${p} from context`}>
                  <X size={10} />
                </button>
              </span>
            ))}
            <button onClick={() => setContextPaths(new Set())} className="text-primary/50 hover:text-primary underline ml-1 shrink-0">clear</button>
          </div>
        )}
      </div>

      <div className="md:hidden flex border-b border-primary/20 shrink-0 overscroll-none">
        <button onClick={() => setMobileTab('chat')} className={`flex-1 py-2.5 text-xs tracking-wider font-bold transition-colors ${mobileTab === 'chat' ? 'bg-primary/15 text-primary neon-glow border-b-2 border-primary' : 'text-primary hover:text-[#39ff14]'}`}>CHAT</button>
        <button onClick={() => setMobileTab('files')} className={`flex-1 py-2.5 text-xs tracking-wider font-bold transition-colors ${mobileTab === 'files' ? 'bg-primary/15 text-primary neon-glow border-b-2 border-primary' : 'text-primary hover:text-[#39ff14]'}`}>FILES</button>
        <button onClick={() => setMobileTab('preview')} className={`flex-1 py-2.5 text-xs tracking-wider font-bold transition-colors ${mobileTab === 'preview' ? 'bg-primary/15 text-primary neon-glow border-b-2 border-primary' : 'text-primary hover:text-[#39ff14]'}`}>PREVIEW</button>
      </div>

      {isMobile ? (
        <div className="flex-1 flex overflow-hidden overscroll-none min-h-0">
          <div className={`${mobileTab === 'chat' ? 'flex' : 'hidden'} flex-1 min-w-0 min-h-0`}>
            <ChatPanel messages={ws.messages} loading={ws.loading} pipelineStages={ws.pipelineStages} onSend={handleSend} onRevert={ws.revertLastPrompt} canRevert={ws.snapshots.length > 0 && !ws.loading} chatMode={ws.chatMode} onSetChatMode={ws.setChatMode} />
          </div>
          <div className={`${mobileTab === 'files' ? 'flex' : 'hidden'} flex-1 flex-col min-w-0 min-h-0`}>
            <FileTree files={ws.files} selectedFile={ws.selectedFile} onSelect={openFile} contextPaths={contextPaths} onToggleContext={toggleContext} />
            <FileViewer file={ws.selectedFile} />
          </div>
          <div className={`${mobileTab === 'preview' ? 'flex' : 'hidden'} flex-1 flex-col min-w-0 min-h-0`}>
            <PreviewPanel files={ws.files} projectId={ws.currentProject.id} compileTarget={ws.currentProject.compile_target} selfDevTouched={ws.lastTouched} />
          </div>
        </div>
      ) : (
        <PanelGroup direction="horizontal" className="flex-1 overflow-hidden min-h-0">
          <Panel defaultSize={33} minSize={15} className="min-w-0 overflow-hidden">
            <ChatPanel messages={ws.messages} loading={ws.loading} pipelineStages={ws.pipelineStages} onSend={handleSend} onRevert={ws.revertLastPrompt} canRevert={ws.snapshots.length > 0 && !ws.loading} chatMode={ws.chatMode} onSetChatMode={ws.setChatMode} />
          </Panel>
          <PanelResizeHandle className="relative w-2 bg-primary/10 hover:bg-primary/30 transition-colors cursor-col-resize shrink-0 group">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-12 bg-primary/30 group-hover:bg-primary rounded-full transition-colors" />
          </PanelResizeHandle>
          <Panel defaultSize={34} minSize={15} className="min-w-0 overflow-hidden">
            <div className="h-full flex flex-col">
              <FileTree files={ws.files} selectedFile={ws.selectedFile} onSelect={openFile} contextPaths={contextPaths} onToggleContext={toggleContext} />
              <FileViewer file={ws.selectedFile} />
            </div>
          </Panel>
          <PanelResizeHandle className="relative w-2 bg-primary/10 hover:bg-primary/30 transition-colors cursor-col-resize shrink-0 group">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-12 bg-primary/30 group-hover:bg-primary rounded-full transition-colors" />
          </PanelResizeHandle>
          <Panel defaultSize={33} minSize={15} className="min-w-0 overflow-hidden">
            <PreviewPanel files={ws.files} projectId={ws.currentProject.id} compileTarget={ws.currentProject.compile_target} selfDevTouched={ws.lastTouched} />
          </Panel>
        </PanelGroup>
      )}

      <SelfDevHistoryModal open={showHistory} onClose={() => setShowHistory(false)} snapshots={ws.snapshots} onRestore={ws.restoreSnapshot} project={ws.currentProject} />

      {showPushConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="bg-background border border-primary/40 max-w-md w-full p-5">
            <div className="flex items-center gap-2 mb-3 text-yellow-500">
              <AlertTriangle size={18} />
              <span className="font-display tracking-wider">PUSH TO PRODUCTION</span>
            </div>
            <p className="text-primary/70 text-sm mb-4 leading-relaxed">
              This pushes the changed files straight to <span className="text-primary">robmitchellengineering-hub/morpheus-self-hosted@main</span> — the real repo — as one commit. Northflank and Netlify redeploy live from it. A verification pass (esbuild syntax + import/export checks over the whole workspace) runs first and blocks the push on any error; still review the changes in the editor and preview yourself.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowPushConfirm(false)} disabled={pushing} className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60`}>CANCEL</button>
              <button onClick={() => doPush(false)} disabled={pushing} className={`${btnBase} text-black bg-primary hover:bg-primary/90 border-primary font-bold disabled:opacity-50`}>
                {pushing ? <Loader2 size={13} className="animate-spin" /> : <Rocket size={13} />} {pushing ? 'VERIFYING & PUSHING…' : 'CONFIRM PUSH'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
