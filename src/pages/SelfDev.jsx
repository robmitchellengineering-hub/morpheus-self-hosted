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
// the currently-open file's path as focusPaths so chatWithMorpheus.js can
// scope its context instead of sending the whole repo every turn.
//
// Nothing here ever pushes automatically — chatting and editing only ever
// touches this project's local ProjectFile rows. Only the explicit PUSH
// button (behind its own confirmation) reaches the real repo.
import { useState, useEffect, useCallback, useRef } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { base44 } from '@/api/base44Client';
import { Cpu, RefreshCw, Rocket, Home as HomeIcon, AlertTriangle, Loader2, CheckCircle2, XCircle, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import ChatPanel from '@/components/matrix/ChatPanel';
import FileTree from '@/components/matrix/FileTree';
import FileViewer from '@/components/matrix/FileViewer';
import PreviewPanel from '@/components/matrix/PreviewPanel';
import HistoryPanel from '@/components/matrix/HistoryPanel';
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
  const [showHistory, setShowHistory] = useState(false);
  const [mobileTab, setMobileTab] = useState('chat');
  const didInit = useRef(false);

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

  const doPush = async () => {
    setPushing(true);
    try {
      const res = await base44.functions.invoke('pushSelfDevToGithub', { projectId: ws.currentProject.id });
      setPushResult({ ok: true, ...res.data });
    } catch (e) {
      setPushResult({ ok: false, error: e.message });
    } finally {
      setPushing(false);
      setShowPushConfirm(false);
    }
  };

  const handleSend = (text, fileUrls) => {
    ws.sendMessage(text, fileUrls, false, ws.selectedFile ? [ws.selectedFile.path] : []);
  };

  if (initializing || !ws.currentProject) {
    return (
      <div className="relative min-h-screen bg-black text-primary font-mono flex items-center justify-center">
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
    <div className="relative h-workspace-mobile bg-black text-primary font-mono flex flex-col overflow-hidden safe-top">
      <div className="flex flex-col border-b border-primary/20 bg-black shrink-0">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <Cpu size={18} className="text-primary shrink-0" />
            <span className="text-primary font-display tracking-wider truncate neon-glow">MORPHEUS SELF-DEV</span>
            <span className="hidden sm:inline text-xs text-primary/75 uppercase border border-primary/30 px-2 py-0.5 shrink-0">{ws.currentProject.status}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button onClick={() => setShowHistory(true)} className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60 hover:bg-primary/5`}>
              HISTORY
            </button>
            <button onClick={syncFromGithub} disabled={syncing} className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60 hover:bg-primary/5 disabled:opacity-50`}>
              <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'SYNCING…' : 'SYNC FROM GITHUB'}
            </button>
            <button onClick={() => setShowPushConfirm(true)} disabled={pushing} className={`${btnBase} text-black bg-primary hover:bg-primary/90 border-primary font-bold disabled:opacity-50`}>
              <Rocket size={13} /> PUSH TO PRODUCTION
            </button>
            <HelpToggle />
            <Link to="/" className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60 hover:bg-primary/5`}>
              <HomeIcon size={13} />
            </Link>
          </div>
        </div>
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
        {pushResult && (
          <div className={`flex items-center justify-between gap-2 border-t px-4 py-1.5 text-[11px] ${pushResult.ok ? 'border-primary/20 bg-primary/5 text-primary/70' : 'border-red-500/30 bg-red-500/10 text-red-400'}`}>
            <span className="flex items-center gap-2">
              {pushResult.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
              {pushResult.ok
                ? <>Pushed {pushResult.fileCount} files to production — <a href={pushResult.commitUrl} target="_blank" rel="noreferrer" className="underline hover:text-primary">view commit</a></>
                : `Push failed: ${pushResult.error}`}
            </span>
            <button onClick={() => setPushResult(null)} className="text-primary/50 hover:text-primary shrink-0"><X size={12} /></button>
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
            <ChatPanel messages={ws.messages} loading={ws.loading} onSend={handleSend} onRevert={ws.revertLastPrompt} canRevert={ws.snapshots.length > 0 && !ws.loading} />
          </div>
          <div className={`${mobileTab === 'files' ? 'flex' : 'hidden'} flex-1 flex-col min-w-0 min-h-0`}>
            <FileTree files={ws.files} selectedFile={ws.selectedFile} onSelect={ws.setSelectedFile} />
            <FileViewer file={ws.selectedFile} />
          </div>
          <div className={`${mobileTab === 'preview' ? 'flex' : 'hidden'} flex-1 flex-col min-w-0 min-h-0`}>
            <PreviewPanel files={ws.files} projectId={ws.currentProject.id} compileTarget={ws.currentProject.compile_target} />
          </div>
        </div>
      ) : (
        <PanelGroup direction="horizontal" className="flex-1 overflow-hidden min-h-0">
          <Panel defaultSize={33} minSize={15} className="min-w-0 overflow-hidden">
            <ChatPanel messages={ws.messages} loading={ws.loading} onSend={handleSend} onRevert={ws.revertLastPrompt} canRevert={ws.snapshots.length > 0 && !ws.loading} />
          </Panel>
          <PanelResizeHandle className="relative w-2 bg-primary/10 hover:bg-primary/30 transition-colors cursor-col-resize shrink-0 group">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-12 bg-primary/30 group-hover:bg-primary rounded-full transition-colors" />
          </PanelResizeHandle>
          <Panel defaultSize={34} minSize={15} className="min-w-0 overflow-hidden">
            <div className="h-full flex flex-col">
              <FileTree files={ws.files} selectedFile={ws.selectedFile} onSelect={ws.setSelectedFile} />
              <FileViewer file={ws.selectedFile} />
            </div>
          </Panel>
          <PanelResizeHandle className="relative w-2 bg-primary/10 hover:bg-primary/30 transition-colors cursor-col-resize shrink-0 group">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-12 bg-primary/30 group-hover:bg-primary rounded-full transition-colors" />
          </PanelResizeHandle>
          <Panel defaultSize={33} minSize={15} className="min-w-0 overflow-hidden">
            <PreviewPanel files={ws.files} projectId={ws.currentProject.id} compileTarget={ws.currentProject.compile_target} />
          </Panel>
        </PanelGroup>
      )}

      <HistoryPanel open={showHistory} onClose={() => setShowHistory(false)} snapshots={ws.snapshots} onRestore={ws.restoreSnapshot} project={ws.currentProject} />

      {showPushConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="bg-black border border-primary/40 max-w-md w-full p-5">
            <div className="flex items-center gap-2 mb-3 text-yellow-500">
              <AlertTriangle size={18} />
              <span className="font-display tracking-wider">PUSH TO PRODUCTION</span>
            </div>
            <p className="text-primary/70 text-sm mb-4 leading-relaxed">
              This pushes every file in this workspace straight to <span className="text-primary">robmitchellengineering-hub/morpheus-self-hosted@main</span> — the real repo. Northflank and Netlify will pick it up and redeploy live. There is no PR/review step; make sure you've reviewed the changes in the file editor and preview first.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowPushConfirm(false)} disabled={pushing} className={`${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60`}>CANCEL</button>
              <button onClick={doPush} disabled={pushing} className={`${btnBase} text-black bg-primary hover:bg-primary/90 border-primary font-bold disabled:opacity-50`}>
                {pushing ? <Loader2 size={13} className="animate-spin" /> : <Rocket size={13} />} {pushing ? 'PUSHING…' : 'CONFIRM PUSH'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
