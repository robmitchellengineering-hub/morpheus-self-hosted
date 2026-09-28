import { useState, useEffect, useRef } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { base44 } from '@/api/base44Client';
import { Plus, Github, Store, Trash2, Pencil, Settings as SettingsIcon, Boxes, Plug, Search, Clock, ArrowDownAZ, X, Home as HomeIcon, AlertTriangle, RefreshCw, Globe } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import PullToRefreshIndicator from '@/components/matrix/PullToRefreshIndicator';
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom';
import ProjectBar from '@/components/matrix/ProjectBar';
import FirstRunChecklist from '@/components/matrix/FirstRunChecklist';
import ChatPanel from '@/components/matrix/ChatPanel';
import { visibleConstructs, noMatchesMessage } from '@/lib/constructSearch';
import FileTree from '@/components/matrix/FileTree';
import FileViewer from '@/components/matrix/FileViewer';
import NewProjectDialog from '@/components/matrix/NewProjectDialog';
import ShareDialog from '@/components/matrix/ShareDialog';
import HistoryPanel from '@/components/matrix/HistoryPanel';
import FeatureModal from '@/components/matrix/FeatureModal';
import MediaPanel from '@/components/matrix/MediaPanel';
import BrandPanel from '@/components/matrix/BrandPanel';
import PublishPanel from '@/components/matrix/PublishPanel';
import FormsPanel from '@/components/matrix/FormsPanel';
import DomainPanel from '@/components/matrix/DomainPanel';
import ContentPanel from '@/components/matrix/ContentPanel';
import WebsitePanel from '@/components/matrix/WebsitePanel';
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
  // A prompt handed over from the on-ramp (/begin → START BUILDING). It is advice for the
  // composer, not state this page owns: the operator's own words are placed in the empty
  // box so they do not have to type the same sentence twice, and nothing is sent for them.
  const seedPrompt = useLocation().state?.seedPrompt || '';
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
  const [showFeature, setShowFeature] = useState(false);
  const [activeFeature, setActiveFeature] = useState(null);
  const [showMedia, setShowMedia] = useState(false);
  const [assetCount, setAssetCount] = useState(0);
  const [showBrand, setShowBrand] = useState(false);
  const [brandSet, setBrandSet] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [publishMissing, setPublishMissing] = useState(0);
  const [showForms, setShowForms] = useState(false);
  const [formsOn, setFormsOn] = useState(false);
  const [showDomain, setShowDomain] = useState(false);
  const [domainSet, setDomainSet] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const [showWebsite, setShowWebsite] = useState(false);
  const [websiteConnected, setWebsiteConnected] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('time');

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // Renaming from the list: a new account's website construct is named from
  // their own name, and this list is where they first see it.
  const [renameId, setRenameId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [mobileTab, setMobileTab] = useState('chat');
  const isMobile = useIsMobile();

  const saveRename = async (p) => {
    const next = renameDraft.trim().slice(0, 80);
    setRenameId(null);
    if (!next || next === p.name) return;
    try {
      await base44.entities.Project.update(p.id, { name: next });
      ws.loadProjects();
    } catch { /* the row keeps its old name, which is honest */ }
  };

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

  // Active feature plan for the FEATURE button badge. Re-fetched after every
  // turn (messages change) so an auto-escalation or a step advance shows up.
  useEffect(() => {
    if (!ws.currentProject?.id) { setActiveFeature(null); return; }
    let cancelled = false;
    base44.functions.invoke('getSelfDevFeatures', { projectId: ws.currentProject.id })
      .then(({ data }) => { if (!cancelled) setActiveFeature(data.active || null); })
      .catch(() => { /* table not migrated on this deployment — panel explains */ });
    return () => { cancelled = true; };
  }, [ws.currentProject?.id, ws.messages.length]);

  // Asset count for the MEDIA button badge + whether a brand is set.
  useEffect(() => {
    if (!ws.currentProject?.id) { setAssetCount(0); setBrandSet(false); setFormsOn(false); setDomainSet(false); return; }
    let cancelled = false;
    base44.functions.listProjectAssets(ws.currentProject.id)
      .then((data) => { if (!cancelled) setAssetCount(data.assets?.length || 0); })
      .catch(() => { /* not migrated — the panel explains */ });
    base44.functions.invoke('getProjectBrand', { projectId: ws.currentProject.id })
      .then(({ data }) => { if (!cancelled) setBrandSet(!!data.set); })
      .catch(() => { /* */ });
    base44.functions.invoke('getProjectForms', { projectId: ws.currentProject.id })
      .then(({ data }) => { if (!cancelled) setFormsOn(!!data.forms?.enabled); })
      .catch(() => { /* */ });
    base44.functions.invoke('getProjectSite', { projectId: ws.currentProject.id })
      .then(({ data }) => { if (!cancelled) setDomainSet(!!data.site?.domain); })
      .catch(() => { /* */ });
    return () => { cancelled = true; };
  }, [ws.currentProject?.id]);

  // Publish-checklist "missing" count for the PUBLISH badge — re-checked after
  // each turn since a build may close gaps.
  useEffect(() => {
    if (!ws.currentProject?.id || ws.currentProject.compile_target !== 'web-app') { setPublishMissing(0); return; }
    let cancelled = false;
    base44.functions.invoke('getPublishChecklist', { projectId: ws.currentProject.id })
      .then(({ data }) => { if (!cancelled) setPublishMissing((data.items || []).filter((i) => !i.done && i.when !== 'data').length); })
      .catch(() => { /* */ });
    return () => { cancelled = true; };
  }, [ws.currentProject?.id, ws.currentProject?.compile_target, ws.messages.length, ws.lastTouched]);

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

  const visibleProjects = visibleConstructs(ws.projects, { query: search, sortBy });

  if (!ws.currentProject) {
    return (
      <div ref={listRef} className="relative min-h-screen bg-background text-ink font-mono">
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
          <p className="text-ink mb-3 text-sm">// Choose an existing project or jack into a new one</p>
          <p className="text-ink mb-4 text-sm">// Set your connections and check capabilities to make sure Morpheus can publish</p>
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
                <span className="text-[10px] text-black/70 tracking-wider">// chat to code</span>
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
                className="flex-1 bg-transparent text-ink text-sm outline-none placeholder:text-ink min-w-0"
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
            {/* A FAILED load must never render as an empty one. This exact block
                used to say "The Matrix is empty" while the request was actually
                throwing (H11), which is indistinguishable from losing everything. */}
            {ws.loadError && (
              <div className="border border-red-500/50 bg-red-500/5 px-4 py-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={16} className="text-red-500 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-red-400 text-sm font-bold">Couldn't load your constructs</p>
                    <p className="text-ink-strong text-xs mt-1 break-words">{ws.loadError}</p>
                    <p className="text-ink-strong text-xs mt-2">
                      Your work has not been deleted — the list simply couldn't be read. Don't create anything to
                      "replace" it until this clears.
                    </p>
                    <button
                      onClick={() => ws.loadProjects()}
                      className="mt-3 flex items-center gap-1.5 px-3 py-1.5 border border-primary/40 text-primary/80 hover:border-primary hover:text-primary text-xs transition-colors"
                    >
                      <RefreshCw size={12} /> Retry
                    </button>
                  </div>
                </div>
              </div>
            )}
            {!ws.loadError && visibleProjects.length === 0 && (
              <div className="border border-dashed border-primary/20 px-4 py-8 text-center space-y-3">
                <p className="text-ink italic text-sm">{search ? noMatchesMessage(search) : 'No constructs found. The Matrix is empty.'}</p>
                {search && (
                  <button onClick={() => setSearch('')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 border border-primary/60 text-primary/85 hover:bg-primary hover:text-black transition-colors text-[12px] tracking-wider">
                    <X size={14} /> SHOW ALL CONSTRUCTS
                  </button>
                )}
                {!search && (
                  <button onClick={() => navigate('/start')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 border border-primary/60 text-primary/85 hover:bg-primary hover:text-black transition-colors text-[12px] tracking-wider">
                    <Globe size={14} /> SET UP MY WORDPRESS SITE
                  </button>
                )}
                {!search && (
                  <p className="text-[10px] text-ink-max leading-relaxed max-w-xs mx-auto">
                    For a WordPress site you already have. Install the free Morpheus plugin on it, connect it, and
                    Morpheus runs the deploys, the shop, the content and the SEO from here. It opens a construct for it.
                  </p>
                )}
              </div>
            )}
            {visibleProjects.map(p => (
              <Card key={p.id} className="group relative rounded-none border-primary/30 bg-card hover:border-primary hover:bg-primary/5 hover:shadow-[0_0_24px_-4px_rgba(0,255,65,0.2)] transition-colors">
                {renameId === p.id ? (
                  <div className="p-4 pr-24">
                    <input autoFocus value={renameDraft} maxLength={80}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => saveRename(p)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); saveRename(p); }
                        if (e.key === 'Escape') { setRenameId(null); }
                      }}
                      className="w-full bg-black/40 border border-primary/40 px-2 py-1.5 text-ink text-sm focus:outline-none focus:border-primary" />
                    <div className="text-[10px] text-ink-max mt-1">Enter to save · Escape to cancel</div>
                  </div>
                ) : (
                  <button onClick={() => navigate('/workspace/' + p.id)} className="w-full text-left p-4 pr-24">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ink group-hover:neon-glow">{p.name}</span>
                      <Badge variant="outline" className="rounded-none border-primary/40 bg-transparent text-primary/70 font-mono text-[10px] uppercase tracking-wider">{p.status}</Badge>
                    </div>
                    {p.description && <p className="text-ink text-sm mt-1.5">{p.description}</p>}
                  </button>
                )}
                {/* Renaming lives here as well as inside the construct: this list
                    is where a default-named construct is first seen. */}
                <button onClick={(e) => { e.stopPropagation(); setRenameId(p.id); setRenameDraft(p.name || ''); }}
                  className="absolute top-3 right-12 text-primary/60 hover:text-primary transition-colors p-1" title="Rename construct">
                  <Pencil size={16} />
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
    <div className="relative h-workspace-mobile bg-background text-ink font-mono flex flex-col overflow-hidden safe-top">
      <ProjectBar project={ws.currentProject} onRename={ws.renameProject} onExport={ws.exportProject} onNew={() => setShowNew(true)} onBack={() => navigate('/workspace')} onUpdateTarget={ws.updateCompileTarget} onShare={() => setShowShare(true)} onHistory={() => setShowHistory(true)} onFeature={() => setShowFeature(true)} activeFeature={activeFeature} onMedia={() => setShowMedia(true)} assetCount={assetCount} onBrand={() => setShowBrand(true)} brandSet={brandSet} onPublish={ws.currentProject?.compile_target === 'web-app' ? () => setShowPublish(true) : undefined} publishMissing={publishMissing} onForms={ws.currentProject?.compile_target === 'web-app' ? () => setShowForms(true) : undefined} formsOn={formsOn} onDomain={ws.currentProject?.compile_target === 'web-app' ? () => setShowDomain(true) : undefined} domainSet={domainSet} onContent={ws.currentProject?.compile_target === 'web-app' ? () => setShowContent(true) : undefined} onWebsite={ws.currentProject?.compile_target === 'web-app' ? () => setShowWebsite(true) : undefined} websiteConnected={websiteConnected} onTests={() => setShowTests(true)} onUsage={() => setShowUsage(true)} onMarket={() => setShowMarket(true)} onSeller={() => setShowSeller(true)} onCompile={() => setShowCompile(true)} onSyncDeps={ws.updateDependencies} onRebuild={() => setShowRebuild(true)} onBackend={() => setShowBackend(true)} onPipeline={() => { setShowPipeline(true); setMobileTab('chat'); }} onTogglePolish={ws.togglePolishUi} />
      {ws.currentProject?.compile_target === 'web-app' && (
        <FirstRunChecklist
          project={ws.currentProject}
          onOpenWebsite={() => { setShowWebsite(true); setMobileTab('chat'); }}
          onOpenConnections={() => setShowConnections(true)}
          onStartChat={() => {
            setMobileTab('chat');
            // Put them in the chat with a start, rather than an empty box.
            setTimeout(() => {
              const box = document.querySelector('textarea[placeholder="speak..."], input[placeholder="speak..."]');
              if (box) {
                box.focus();
                box.placeholder = 'e.g. change the homepage headline to…';
              }
            }, 50);
          }}
        />
      )}
      <div className="md:hidden flex border-b border-primary/20 shrink-0 overscroll-none">
        <button onClick={() => setMobileTab('chat')} className={`flex-1 py-2.5 text-xs tracking-wider font-bold transition-colors ${mobileTab === 'chat' ? 'bg-primary/15 text-primary neon-glow border-b-2 border-primary' : 'text-primary hover:text-[#39ff14]'}`}>CHAT</button>
        <button onClick={() => setMobileTab('files')} className={`flex-1 py-2.5 text-xs tracking-wider font-bold transition-colors ${mobileTab === 'files' ? 'bg-primary/15 text-primary neon-glow border-b-2 border-primary' : 'text-primary hover:text-[#39ff14]'}`}>FILES</button>
        <button onClick={() => setMobileTab('preview')} className={`flex-1 py-2.5 text-xs tracking-wider font-bold transition-colors ${mobileTab === 'preview' ? 'bg-primary/15 text-primary neon-glow border-b-2 border-primary' : 'text-primary hover:text-[#39ff14]'}`}>PREVIEW</button>
      </div>
      {isMobile ? (
        <div className="flex-1 flex overflow-hidden overscroll-none min-h-0">
          <div className={`${mobileTab === 'chat' ? 'flex' : 'hidden'} flex-1 min-w-0 min-h-0`}>
            <ChatPanel messages={ws.messages} loading={ws.loading} pipelineStages={ws.pipelineStages} onSend={ws.sendMessage} onRevert={ws.revertLastPrompt} canRevert={ws.snapshots.length > 0 && !ws.loading}  onAutonomous={() => setShowAutonomous(true)} chatMode={ws.chatMode} onSetChatMode={ws.setChatMode} webAccess={ws.webAccess} onSetWebAccess={ws.setWebAccess} seed={seedPrompt} />
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
            <ChatPanel messages={ws.messages} loading={ws.loading} pipelineStages={ws.pipelineStages} onSend={ws.sendMessage} onRevert={ws.revertLastPrompt} canRevert={ws.snapshots.length > 0 && !ws.loading}  onAutonomous={() => setShowAutonomous(true)} chatMode={ws.chatMode} onSetChatMode={ws.setChatMode} webAccess={ws.webAccess} onSetWebAccess={ws.setWebAccess} seed={seedPrompt} />
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
      <ShareDialog open={showShare} onClose={() => setShowShare(false)} project={ws.currentProject} onUploadGithub={ws.uploadToGithub} onDisconnectGithub={ws.disconnectGithub} onSyncFromGithub={ws.syncFromGithub} onSetStorageMode={ws.setStorageMode} onPushToDrive={ws.pushToDrive} onPullFromDrive={ws.pullFromDrive} onEmail={ws.emailProjectFiles} />
      <HistoryPanel open={showHistory} onClose={() => setShowHistory(false)} snapshots={ws.snapshots} onRestore={ws.restoreSnapshot} project={ws.currentProject} />
      <FeatureModal open={showFeature} onClose={() => setShowFeature(false)} projectId={ws.currentProject?.id} onActiveChange={setActiveFeature} />
      <MediaPanel open={showMedia} onClose={() => setShowMedia(false)} projectId={ws.currentProject?.id} onCountChange={setAssetCount} />
      <BrandPanel open={showBrand} onClose={() => setShowBrand(false)} projectId={ws.currentProject?.id} onSetChange={setBrandSet} />
      <PublishPanel open={showPublish} onClose={() => setShowPublish(false)} projectId={ws.currentProject?.id} onRequestFix={(text) => ws.sendMessage(text)} />
      <FormsPanel open={showForms} onClose={() => setShowForms(false)} projectId={ws.currentProject?.id} onSetChange={setFormsOn} />
      <DomainPanel open={showDomain} onClose={() => setShowDomain(false)} projectId={ws.currentProject?.id} onSetChange={setDomainSet} />
      <ContentPanel open={showContent} onClose={() => setShowContent(false)} projectId={ws.currentProject?.id} />
      <WebsitePanel open={showWebsite} onClose={() => setShowWebsite(false)} projectId={ws.currentProject?.id} onConnectedChange={setWebsiteConnected} />
      <AutonomousPanel open={showAutonomous} onClose={() => setShowAutonomous(false)} project={ws.currentProject} onStep={ws.runAutonomousStep} onSendToChat={(msg) => { setShowAutonomous(false); setMobileTab('chat'); ws.sendMessage(msg); }} />
      <TestsPanel open={showTests} onClose={() => setShowTests(false)} project={ws.currentProject} onGenerate={ws.generateTests} />
      <UsagePanel open={showUsage} onClose={() => setShowUsage(false)} />
      <MarketplacePanel open={showMarket} onClose={() => setShowMarket(false)} currentProject={ws.currentProject} onInstalled={async (data) => { await ws.loadProjects(); setShowMarket(false); if (data?.projectId) navigate('/workspace/' + data.projectId); }} />
      <SellerPanel open={showSeller} onClose={() => setShowSeller(false)} />
      <CompilePanel open={showCompile} onClose={() => setShowCompile(false)} project={ws.currentProject} onCompile={ws.compileProject} onPreview={ws.previewCompile} onCheckStatus={ws.checkCompileStatus} onCompileSuccess={ws.saveCompiledArtifacts} onBuildBackend={() => { setShowCompile(false); setShowBackend(true); }} onAskMorpheus={(diagnosis) => {
        // 2026-09-04: the diagnoseIssue backend function now automatically
        // logs a "// SYSTEM — AI DIAGNOSIS ..." message (same summary/
        // autoFixed/needsUserAction detail this used to re-type here) into
        // chat history the moment diagnosis completes — see diagnoseIssue.js.
        // That message is already in `history` by the time this turn's
        // chatWithMorpheus call runs, so repeating the full summary here
        // would just show it twice in the thread. This button's real job is
        // no longer "record what happened" (automatic now) — it's "ask
        // Morpheus to actually act on what's left," so it only needs to say
        // that.
        //
        // 2026-09-08 fix (Rob): the needsUserAction-false branch used to say
        // "the diagnosis above auto-fixed everything it found — please
        // recompile," which reads to Morpheus as "nothing left to do" even
        // when the build is still actively failing (diagnosis can report
        // autoFixed while the underlying compile keeps erroring). Rob's own
        // manual messages that actually get results are phrased as a direct
        // investigate-and-fix instruction ("look at the ai fix log files and
        // fix the issues it wont compile"), not a status recap. Both branches
        // below now tell Morpheus to go look at the logs/files itself and fix
        // what's actually wrong, instead of asserting a state Morpheus should
        // just take on faith.
        const msg = diagnosis.needsUserAction?.length
          ? `Look at the AI fix log and the current files yourself and fix the remaining issues so the ${ws.currentProject?.compile_target || 'binary'} compile succeeds.`
          : `It's still not compiling. Look at the AI fix log above and the current files yourself — don't assume they're already correct — and fix whatever's actually wrong so the ${ws.currentProject?.compile_target || 'binary'} compile succeeds.`;
        setShowCompile(false);
        setMobileTab('chat');
        ws.sendMessage(msg);
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