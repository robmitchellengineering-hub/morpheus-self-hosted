import { useState, useEffect, useRef } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { base44 } from '@/api/base44Client';
import { Plus, Github, Store, Trash2, Settings as SettingsIcon, Boxes, Plug, Search, Clock, ArrowDownAZ, X, Home as HomeIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import ConnectionsDialog from '@/components/matrix/ConnectionsDialog';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { useIsMobile } from '@/hooks/use-mobile';

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
  const [showConnections, setShowConnections] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('time');

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [mobileTab, setMobileTab] = useState('chat');
  const isMobile = useIsMobile();

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

  const visibleProjects = ws.projects
    .filter(p => !p.project_type || p.project_type === 'frontend')
    .filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortBy === 'name'
      ? a.name.localeCompare(b.name)
      : new Date(b.updated_date || b.created_date) - new Date(a.updated_date || a.created_date)
    );

  if (!ws.currentProject) {
    return (
      <div ref={listRef} className="relative min-h-screen bg-background text-primary font-mono">
        <MatrixRain opacity={0.05} />
        <div className="pointer-events-none fixed inset-0 opacity-[0.05]" style={{ backgroundImage: 'linear-gradient(to right, hsl(var(--primary) / 0.5) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--primary) / 0.5) 1px, transparent 1px)', backgroundSize: '44px 44px' }} />
        <div className="relative z-10"><PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} /></div>
        <div className="relative z-10 max-w-4xl mx-auto px-6 py-16 safe-top">
          <div className="flex items-center justify-between mb-2 gap-3">
            <h1 className="text-3xl md:text-4xl font-display tracking-widest neon-glow text-heading">SELECT YOUR CONSTRUCT</h1>
            <div className="flex items-center gap-2 shrink-0">
              <BuildStamp />
              <HelpToggle />
              <Button asChild variant="outline" size="sm" className="rounded-none border-primary/40 text-primary/70 hover:border-primary hover:text-primary hover:bg-primary/10 shrink-0">
                <Link to="/"><HomeIcon size={14} /> <span className="hidden sm:inline">HOME</span></Link>
              </Button>
              <Button asChild variant="outline" size="sm" className="rounded-none border-primary/40 text-primary/70 hover:border-primary hover:text-primary hover:bg-primary/10 shrink-0">
                <Link to="/settings"><SettingsIcon size={14} /> <span className="hidden sm:inline">SETTINGS</span></Link>
              </Button>
            </div>
          </div>
          <p className="text-primary/60 mb-3 text-sm">// Choose an existing project or jack into a new one</p>
          <p className="text-primary/60 mb-4 text-sm">// Set your connections and check capabilities to make sure Morpheus can publish</p>
          <div className="flex flex-col sm:flex-row gap-3 mb-8">
            <HelpHint id="connections" title="Connections" body="Set up and review your integrations — GitHub, hosting platforms (Cloudflare, Vercel, Supabase, etc.), and databases. Shows what's connected and a live Morpheus capability matrix of what you can do end-to-end.">
              <button onClick={() => setShowConnections(true)} className="flex flex-col items-start gap-0.5 px-6 py-3 border border-primary/50 text-primary/70 hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors">
                <span className="flex items-center gap-2"><Plug size={18} /> CONNECTIONS</span>
                <span className="text-[10px] text-primary/75 tracking-wider">// set up integrations</span>
              </button>
            </HelpHint>
            <HelpHint id="new-construct" title="New Construct" body="Start a new project from scratch. Morpheus builds it with you through the chat. Pick a compile target (Android APK, Windows .exe, etc.) or leave it on 'source' for plain code.">
              <button onClick={() => setShowNew(true)} className="flex flex-col items-start gap-0.5 px-6 py-3 bg-primary text-black hover:bg-primary/90 transition-colors shadow-[0_0_24px_-6px_rgba(0,255,65,0.5)]">
                <span className="flex items-center gap-2 font-bold"><Plus size={18} /> NEW CONSTRUCT</span>
                <span className="text-[10px] text-black/70 tracking-wider">// frontend development</span>
              </button>
            </HelpHint>
            <Link to="/architect" className="flex flex-col items-start gap-0.5 px-6 py-3 border border-primary/50 text-primary/70 hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors">
              <span className="flex items-center gap-2"><Boxes size={18} /> ARCHITECT</span>
              <span className="text-[10px] text-primary/75 tracking-wider">// backend development</span>
            </Link>
            <HelpHint id="import-github" title="Import from GitHub" body="Pull an existing GitHub repo into Morpheus. You'll need your GitHub account connected first (see the CONNECT GITHUB link). Morpheus imports the files so you can iterate on them here.">
              <button onClick={() => setShowImport(true)} className="flex items-center gap-2 px-6 py-3 border border-primary/50 text-primary/70 hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors">
                <Github size={18} /> IMPORT FROM GITHUB
              </button>
            </HelpHint>
          </div>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-[10px] text-primary/50 tracking-[0.2em] font-display">// EXISTING CONSTRUCTS</span>
            <div className="flex-1 h-px bg-gradient-to-r from-primary/20 to-transparent" />
          </div>
          <div className="flex gap-2 mb-3">
            <div className="flex-1 flex items-center gap-2 border border-primary/30 px-3 py-2">
              <Search size={14} className="text-primary/50 shrink-0" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search constructs..."
                className="flex-1 bg-transparent text-primary text-sm outline-none placeholder:text-primary/30 min-w-0"
              />
              {search && <button onClick={() => setSearch('')} className="text-primary/50 hover:text-primary shrink-0"><X size={14} /></button>}
            </div>
            <button
              onClick={() => setSortBy(s => s === 'time' ? 'name' : 'time')}
              className="flex items-center gap-1.5 px-3 py-2 border border-primary/30 text-primary/70 hover:border-primary hover:text-primary text-sm whitespace-nowrap transition-colors"
              title={sortBy === 'time' ? 'Sort by newest first' : 'Sort by name A-Z'}
            >
              {sortBy === 'time' ? <Clock size={14} /> : <ArrowDownAZ size={14} />}
              {sortBy === 'time' ? 'NEWEST' : 'A-Z'}
            </button>
          </div>
          <div className="space-y-3 mb-10">
            {visibleProjects.length === 0 && (
              <div className="border border-dashed border-primary/20 px-4 py-8 text-center">
                <p className="text-primary/60 italic text-sm">{search ? 'No constructs match your search.' : 'No constructs found. The Matrix is empty. Create your first.'}</p>
              </div>
            )}
            {visibleProjects.map(p => (
              <Card key={p.id} className="group relative rounded-none border-primary/30 bg-card hover:border-primary hover:bg-primary/5 hover:shadow-[0_0_24px_-4px_rgba(0,255,65,0.2)] transition-colors">
                <button onClick={() => navigate('/workspace/' + p.id)} className="w-full text-left p-4 pr-12">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-primary group-hover:neon-glow">{p.name}</span>
                    <Badge variant="outline" className="rounded-none border-primary/40 bg-transparent text-primary/70 font-mono text-[10px] uppercase tracking-wider">{p.status}</Badge>
                  </div>
                  {p.description && <p className="text-primary/50 text-sm mt-1.5">{p.description}</p>}
                </button>
                <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(p); }} className="absolute top-3 right-3 text-primary/60 hover:text-red-500 transition-colors p-1" title="Delete construct">
                  <Trash2 size={16} />
                </button>
              </Card>
            ))}
          </div>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-[10px] text-primary/50 tracking-[0.2em] font-display">// MARKETPLACE</span>
            <div className="flex-1 h-px bg-gradient-to-r from-primary/20 to-transparent" />
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <HelpHint id="browse-market" title="Browse Market" body="Browse community templates. Install free ones or buy premium templates with Stripe checkout. Installed templates become projects you can modify and compile.">
              <button onClick={() => setShowMarket(true)} className="flex items-center gap-2 px-6 py-3 border border-primary/50 text-primary/70 hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors">
                <Store size={18} /> BROWSE MARKET
              </button>
            </HelpHint>
          </div>
        </div>
        <NewProjectDialog open={showNew} onClose={() => setShowNew(false)} onCreate={async (n, d, t) => { const p = await ws.createProject(n, d, t); setShowNew(false); if (p?.id) navigate('/workspace/' + p.id); }} />
        <ImportGithubDialog open={showImport} onClose={() => setShowImport(false)} onImport={async (repo, target) => { const data = await ws.importFromGithub(repo, target); setShowImport(false); if (data?.projectId) navigate('/workspace/' + data.projectId); }} />
        <MarketplacePanel open={showMarket} onClose={() => setShowMarket(false)} onInstalled={async () => { await ws.loadProjects(); setShowMarket(false); }} />
        <DeleteConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} projectName={deleteTarget?.name} loading={deleting} onConfirm={async () => { setDeleting(true); try { await ws.deleteProject(deleteTarget); setDeleteTarget(null); if (projectId) navigate('/workspace'); } finally { setDeleting(false); } }} />
        <ConnectionsDialog open={showConnections} onClose={() => setShowConnections(false)} />
      </div>
    );
  }

  return (
    <div className="relative h-workspace-mobile bg-background text-primary font-mono flex flex-col overflow-hidden safe-top">
      <ProjectBar project={ws.currentProject} onExport={ws.exportProject} onNew={() => setShowNew(true)} onBack={() => navigate('/workspace')} onUpdateTarget={ws.updateCompileTarget} onShare={() => setShowShare(true)} onHistory={() => setShowHistory(true)} onTests={() => setShowTests(true)} onUsage={() => setShowUsage(true)} onMarket={() => setShowMarket(true)} onSeller={() => setShowSeller(true)} onCompile={() => setShowCompile(true)} onSyncDeps={ws.updateDependencies} onRebuild={() => setShowRebuild(true)} onBackend={() => setShowBackend(true)} onPipeline={() => { setShowPipeline(true); setMobileTab('chat'); }} onTogglePolish={ws.togglePolishUi} />
      <div className="md:hidden flex border-b border-primary/20 shrink-0 overscroll-none">
        <button onClick={() => setMobileTab('chat')} className={`flex-1 py-2.5 text-xs tracking-wider font-bold transition-colors ${mobileTab === 'chat' ? 'bg-primary/15 text-primary neon-glow border-b-2 border-primary' : 'text-primary hover:text-[#39ff14]'}`}>CHAT</button>
        <button onClick={() => setMobileTab('files')} className={`flex-1 py-2.5 text-xs tracking-wider font-bold transition-colors ${mobileTab === 'files' ? 'bg-primary/15 text-primary neon-glow border-b-2 border-primary' : 'text-primary hover:text-[#39ff14]'}`}>FILES</button>
        <button onClick={() => setMobileTab('preview')} className={`flex-1 py-2.5 text-xs tracking-wider font-bold transition-colors ${mobileTab === 'preview' ? 'bg-primary/15 text-primary neon-glow border-b-2 border-primary' : 'text-primary hover:text-[#39ff14]'}`}>PREVIEW</button>
      </div>
      {isMobile ? (
        <div className="flex-1 flex overflow-hidden overscroll-none min-h-0">
          <div className={`${mobileTab === 'chat' ? 'flex' : 'hidden'} flex-1 min-w-0 min-h-0`}>
            <ChatPanel messages={ws.messages} loading={ws.loading} onSend={ws.sendMessage} onRevert={ws.revertLastPrompt} canRevert={ws.snapshots.length > 0 && !ws.loading} onAutonomous={() => setShowAutonomous(true)} />
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
            <ChatPanel messages={ws.messages} loading={ws.loading} onSend={ws.sendMessage} onRevert={ws.revertLastPrompt} canRevert={ws.snapshots.length > 0 && !ws.loading} onAutonomous={() => setShowAutonomous(true)} />
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