import { useState, useEffect, useRef } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { base44 } from '@/api/base44Client';
import { Plus, Github, Store, Trash2, Settings as SettingsIcon, Boxes } from 'lucide-react';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import PullToRefreshIndicator from '@/components/matrix/PullToRefreshIndicator';
import { Link, useParams, useNavigate } from 'react-router-dom';
import ProjectBar from '@/components/matrix/ProjectBar';
import ChatPanel from '@/components/matrix/ChatPanel';
import FileTree from '@/components/matrix/FileTree';
import FileViewer from '@/components/matrix/FileViewer';
import NewProjectDialog from '@/components/matrix/NewProjectDialog';
import ShareDialog from '@/components/matrix/ShareDialog';
import HistoryPanel from '@/components/matrix/HistoryPanel';
import AutonomousPanel from '@/components/matrix/AutonomousPanel';
import TestsPanel from '@/components/matrix/TestsPanel';
import UsagePanel from '@/components/matrix/UsagePanel';
import MarketplacePanel from '@/components/matrix/MarketplacePanel';
import SellerPanel from '@/components/matrix/SellerPanel';
import ImportGithubDialog from '@/components/matrix/ImportGithubDialog';
import DeleteConfirmDialog from '@/components/matrix/DeleteConfirmDialog';
import CompilePanel from '@/components/matrix/CompilePanel';
import BackendPanel from '@/components/matrix/BackendPanel';
import PipelineRunner from '@/components/matrix/PipelineRunner';
import RebuildDocDialog from '@/components/matrix/RebuildDocDialog';
import PreviewPanel from '@/components/matrix/PreviewPanel';
import MatrixRain from '@/components/matrix/MatrixRain';
import BuildStamp from '@/components/matrix/BuildStamp';
import HelpToggle from '@/components/matrix/HelpToggle';
import HelpHint from '@/components/matrix/HelpHint';

export default function Workspace() {
  const ws = useWorkspace();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [showNew, setShowNew] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showAutonomous, setShowAutonomous] = useState(false);
  const [showTests, setShowTests] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [showMarket, setShowMarket] = useState(false);
  const [showSeller, setShowSeller] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showCompile, setShowCompile] = useState(false);
  const [showBackend, setShowBackend] = useState(false);
  const [showRebuild, setShowRebuild] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [mobileTab, setMobileTab] = useState('chat');

  // Pull-to-refresh for the construct list view. Suspended while a project is
  // open (the list isn't mounted then); re-engages when the user returns to it.
  const listRef = useRef(null);
  const { pullDistance, refreshing } = usePullToRefresh({
    onRefresh: ws.loadProjects,
    containerRef: listRef,
    disabled: !!ws.currentProject,
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('purchase') === 'success') {
      setShowMarket(true);
    }
  }, []);

  // Sync project selection with the route so the hardware back button
  // returns to the project list and history is preserved.
  useEffect(() => {
    if (projectId) {
      if (ws.currentProject?.id === projectId) return;
      const found = ws.projects.find(p => p.id === projectId);
      if (found) {
        ws.selectProject(found);
      } else {
        // Project not in the loaded list yet — fetch it directly
        base44.entities.Project.get(projectId)
          .then(p => ws.selectProject(p))
          .catch(() => navigate('/workspace', { replace: true }));
      }
    } else if (ws.currentProject) {
      ws.deselectProject();
    }
  }, [projectId, ws.projects]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ws.currentProject) {
    return (
      <div ref={listRef} className="relative min-h-screen bg-black text-[#00ff41] font-mono">
        <MatrixRain opacity={0.05} />
        <div className="relative z-10"><PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} /></div>
        <div className="relative z-10 max-w-4xl mx-auto px-6 py-16 safe-top">
          <div className="flex items-center justify-between mb-2 gap-3">
            <h1 className="text-3xl md:text-4xl font-display tracking-widest neon-glow">SELECT YOUR CONSTRUCT</h1>
            <div className="flex items-center gap-2 shrink-0">
              <BuildStamp />
              <Link to="/settings" className="flex items-center gap-1 text-xs text-[#00ff41]/60 hover:text-[#00ff41] border border-[#00ff41]/30 hover:border-[#00ff41]/60 px-3 py-1.5 transition-colors shrink-0">
                <SettingsIcon size={14} /> <span className="hidden sm:inline">SETTINGS</span>
              </Link>
            </div>
          </div>
          <p className="text-[#00ff41]/60 mb-4 text-sm">// Choose an existing project or jack into a new one</p>
          <div className="flex flex-col sm:flex-row gap-3 mb-8">
            <HelpToggle />
            <HelpHint id="new-construct" title="New Construct" body="Start a new project from scratch. Morpheus builds it with you through the chat. Pick a compile target (Android APK, Windows .exe, etc.) or leave it on 'source' for plain code.">
              <button onClick={() => setShowNew(true)} className="flex flex-col items-start gap-0.5 px-6 py-3 border border-[#00ff41] text-[#00ff41] hover:bg-[#00ff41] hover:text-black transition-colors">
                <span className="flex items-center gap-2"><Plus size={18} /> NEW CONSTRUCT</span>
                <span className="text-[10px] text-[#00ff41]/75 tracking-wider">// frontend development</span>
              </button>
            </HelpHint>
            <Link to="/architect" className="flex flex-col items-start gap-0.5 px-6 py-3 border border-[#00ff41]/50 text-[#00ff41]/70 hover:border-[#00ff41] hover:text-[#00ff41] transition-colors">
              <span className="flex items-center gap-2"><Boxes size={18} /> ARCHITECT</span>
              <span className="text-[10px] text-[#00ff41]/75 tracking-wider">// backend development</span>
            </Link>
            <HelpHint id="import-github" title="Import from GitHub" body="Pull an existing GitHub repo into Morpheus. You'll need your GitHub account connected first (see the CONNECT GITHUB link). Morpheus imports the files so you can iterate on them here.">
              <button onClick={() => setShowImport(true)} className="flex items-center gap-2 px-6 py-3 border border-[#00ff41]/50 text-[#00ff41]/70 hover:border-[#00ff41] hover:text-[#00ff41] transition-colors">
                <Github size={18} /> IMPORT FROM GITHUB
              </button>
            </HelpHint>
          </div>
          <div className="space-y-3 mb-8">
            {ws.projects.filter(p => !p.project_type || p.project_type === 'frontend').length === 0 && (
              <p className="text-[#00ff41]/75 italic">No constructs found. The Matrix is empty. Create your first.</p>
            )}
            {ws.projects.filter(p => !p.project_type || p.project_type === 'frontend').map(p => (
              <div key={p.id} className="relative group border border-[#00ff41]/30 hover:border-[#00ff41] hover:bg-[#00ff41]/5 transition-colors">
                <button onClick={() => navigate('/workspace/' + p.id)} className="w-full text-left p-4 pr-12">
                  <div className="flex items-center justify-between">
                    <span className="text-[#00ff41] group-hover:neon-glow">{p.name}</span>
                    <span className="text-xs text-[#00ff41]/75 uppercase">{p.status}</span>
                  </div>
                  {p.description && <p className="text-[#00ff41]/50 text-sm mt-1">{p.description}</p>}
                </button>
                <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(p); }} className="absolute top-3 right-3 text-[#00ff41]/65 hover:text-red-500 transition-colors p-1" title="Delete construct">
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <HelpHint id="browse-market" title="Browse Market" body="Browse community templates. Install free ones or buy premium templates with Stripe checkout. Installed templates become projects you can modify and compile.">
              <button onClick={() => setShowMarket(true)} className="flex items-center gap-2 px-6 py-3 border border-[#00ff41]/50 text-[#00ff41]/70 hover:border-[#00ff41] hover:text-[#00ff41] transition-colors">
                <Store size={18} /> BROWSE MARKET
              </button>
            </HelpHint>
          </div>
        </div>
        <NewProjectDialog open={showNew} onClose={() => setShowNew(false)} onCreate={async (n, d, t) => { const p = await ws.createProject(n, d, t); setShowNew(false); if (p?.id) navigate('/workspace/' + p.id); }} />
        <ImportGithubDialog open={showImport} onClose={() => setShowImport(false)} onImport={async (repo, target) => { const data = await ws.importFromGithub(repo, target); setShowImport(false); if (data?.projectId) navigate('/workspace/' + data.projectId); }} />
        <MarketplacePanel open={showMarket} onClose={() => setShowMarket(false)} onInstalled={async () => { await ws.loadProjects(); setShowMarket(false); }} />
        <DeleteConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} projectName={deleteTarget?.name} loading={deleting} onConfirm={async () => { setDeleting(true); try { await ws.deleteProject(deleteTarget); setDeleteTarget(null); if (projectId) navigate('/workspace'); } finally { setDeleting(false); } }} />
      </div>
    );
  }

  return (
    <div className="relative h-[calc(100vh-3.75rem)] md:h-screen bg-black text-[#00ff41] font-mono flex flex-col overflow-hidden safe-top">
      <ProjectBar project={ws.currentProject} onExport={ws.exportProject} onNew={() => setShowNew(true)} onBack={() => navigate('/workspace')} onUpdateTarget={ws.updateCompileTarget} onShare={() => setShowShare(true)} onHistory={() => setShowHistory(true)} onTests={() => setShowTests(true)} onUsage={() => setShowUsage(true)} onMarket={() => setShowMarket(true)} onSeller={() => setShowSeller(true)} onCompile={() => setShowCompile(true)} onSyncDeps={ws.updateDependencies} onRebuild={() => setShowRebuild(true)} onBackend={() => setShowBackend(true)} onPipeline={() => { setShowPipeline(true); setMobileTab('chat'); }} onTogglePolish={ws.togglePolishUi} />
      <div className="md:hidden flex border-b border-[#00ff41]/20 shrink-0 overscroll-none">
        <button onClick={() => setMobileTab('chat')} className={`flex-1 py-2 text-xs tracking-wider ${mobileTab === 'chat' ? 'bg-[#00ff41]/10 text-[#00ff41]' : 'text-[#00ff41]/75'}`}>CHAT</button>
        <button onClick={() => setMobileTab('files')} className={`flex-1 py-2 text-xs tracking-wider ${mobileTab === 'files' ? 'bg-[#00ff41]/10 text-[#00ff41]' : 'text-[#00ff41]/75'}`}>FILES</button>
        <button onClick={() => setMobileTab('preview')} className={`flex-1 py-2 text-xs tracking-wider ${mobileTab === 'preview' ? 'bg-[#00ff41]/10 text-[#00ff41]' : 'text-[#00ff41]/75'}`}>PREVIEW</button>
      </div>
      <div className="flex-1 flex overflow-hidden overscroll-none">
        <div className={`${mobileTab === 'chat' ? 'flex' : 'hidden'} md:flex flex-1 border-r border-[#00ff41]/20 min-w-0`}>
          <ChatPanel messages={ws.messages} loading={ws.loading} onSend={ws.sendMessage} onRevert={ws.revertLastPrompt} canRevert={ws.snapshots.length > 0 && !ws.loading} onAutonomous={() => setShowAutonomous(true)} />
        </div>
        <div className={`${mobileTab === 'files' ? 'flex' : 'hidden'} md:flex flex-1 flex-col min-w-0`}>
          <FileTree files={ws.files} selectedFile={ws.selectedFile} onSelect={ws.setSelectedFile} />
          <FileViewer file={ws.selectedFile} />
        </div>
        <div className={`${mobileTab === 'preview' ? 'flex' : 'hidden'} md:flex flex-1 flex-col border-l border-[#00ff41]/20 min-w-0`}>
          <PreviewPanel files={ws.files} projectId={ws.currentProject.id} compileTarget={ws.currentProject.compile_target} />
        </div>
      </div>
      <NewProjectDialog open={showNew} onClose={() => setShowNew(false)} onCreate={async (n, d, t) => { const p = await ws.createProject(n, d, t); setShowNew(false); if (p?.id) navigate('/workspace/' + p.id); }} />
      <ShareDialog open={showShare} onClose={() => setShowShare(false)} project={ws.currentProject} onUploadGithub={ws.uploadToGithub} onEmail={ws.emailProjectFiles} />
      <HistoryPanel open={showHistory} onClose={() => setShowHistory(false)} snapshots={ws.snapshots} onRestore={ws.restoreSnapshot} project={ws.currentProject} />
      <AutonomousPanel open={showAutonomous} onClose={() => setShowAutonomous(false)} project={ws.currentProject} onStep={ws.runAutonomousStep} onSendToChat={(msg) => { setShowAutonomous(false); setMobileTab('chat'); ws.sendMessage(msg); }} />
      <TestsPanel open={showTests} onClose={() => setShowTests(false)} project={ws.currentProject} onGenerate={ws.generateTests} />
      <UsagePanel open={showUsage} onClose={() => setShowUsage(false)} />
      <MarketplacePanel open={showMarket} onClose={() => setShowMarket(false)} currentProject={ws.currentProject} onInstalled={async (data) => { await ws.loadProjects(); setShowMarket(false); if (data?.projectId) navigate('/workspace/' + data.projectId); }} />
      <SellerPanel open={showSeller} onClose={() => setShowSeller(false)} />
      <CompilePanel open={showCompile} onClose={() => setShowCompile(false)} project={ws.currentProject} onCompile={ws.compileProject} onPreview={ws.previewCompile} onCheckStatus={ws.checkCompileStatus} onCompileSuccess={ws.saveCompiledArtifacts} onBuildBackend={() => { setShowCompile(false); setShowBackend(true); }} onAskMorpheus={(diagnosis) => {
        const msg = [`The ${ws.currentProject?.compile_target || 'binary'} compile failed. AI diagnosis was run:`, '', diagnosis.summary];
        if (diagnosis.autoFixed?.length) {
          msg.push('', 'Auto-fixed:');
          diagnosis.autoFixed.forEach(f => msg.push(`- ${f.component}: ${f.fix} (${f.fileCount} file(s) regenerated)`));
        }
        if (diagnosis.needsUserAction?.length) {
          msg.push('', 'Still needs fixing:');
          diagnosis.needsUserAction.forEach(a => msg.push(`- ${a.component}: ${a.issue}`));
        }
        msg.push('', 'Please fix the remaining code issues so the compile succeeds.');
        setShowCompile(false);
        setMobileTab('chat');
        ws.sendMessage(msg.join('\n'));
      }} />
      <BackendPanel open={showBackend} onClose={() => setShowBackend(false)} project={ws.currentProject} />
      <RebuildDocDialog open={showRebuild} onClose={() => setShowRebuild(false)} />
      {showPipeline && (
        <PipelineRunner
          project={ws.currentProject}
          sendMessage={ws.sendMessage}
          compileProject={ws.compileProject}
          checkCompileStatus={ws.checkCompileStatus}
          loadFiles={ws.loadFiles}
          onClose={() => setShowPipeline(false)}
        />
      )}
    </div>
  );
}