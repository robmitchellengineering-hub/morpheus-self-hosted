import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Plus, Server, Trash2, ArrowLeft, Search, Clock, ArrowDownAZ, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import BackendPanel from '@/components/matrix/BackendPanel';
import NewBackendDialog from '@/components/matrix/NewBackendDialog';
import DeleteConfirmDialog from '@/components/matrix/DeleteConfirmDialog';
import MatrixRain from '@/components/matrix/MatrixRain';
import BuildStamp from '@/components/matrix/BuildStamp';
import HelpToggle from '@/components/matrix/HelpToggle';
import HelpHint from '@/components/matrix/HelpHint';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import PullToRefreshIndicator from '@/components/matrix/PullToRefreshIndicator';

export default function Architect() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [selectedProject, setSelectedProject] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const listRef = useRef(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('time');

  const visibleProjects = projects
    .filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortBy === 'name'
      ? a.name.localeCompare(b.name)
      : new Date(b.updated_date || b.created_date) - new Date(a.updated_date || a.created_date)
    );

  const loadProjects = async () => {
    setLoading(true);
    try {
      const data = await base44.entities.Project.list('-created_date', 50);
      setProjects(data.filter(p => p.project_type === 'backend'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadProjects(); }, []);

  const { pullDistance, refreshing } = usePullToRefresh({
    onRefresh: loadProjects,
    containerRef: listRef,
  });

  const createProject = async (name, description, uploadFiles) => {
    const project = await base44.entities.Project.create({
      name,
      description,
      status: 'init',
      compile_target: 'source',
      project_type: 'backend'
    });
    if (uploadFiles && uploadFiles.length > 0) {
      await base44.entities.ProjectFile.bulkCreate(
        uploadFiles.map(f => ({
          project_id: project.id,
          path: `external/${f.path}`,
          content: f.content,
          file_url: f.file_url,
          language: f.language || 'text',
        }))
      );
    }
    await loadProjects();
    setSelectedProject(project);
  };

  const deleteProject = async (project) => {
    await base44.entities.ProjectFile.deleteMany({ project_id: project.id });
    await base44.entities.Project.delete(project.id);
    await loadProjects();
  };

  return (
    <div className="relative min-h-screen bg-background text-primary font-mono">
      <MatrixRain opacity={0.05} />
      <div className="relative z-10 max-w-4xl mx-auto px-6 py-16 safe-top">
        <div className="flex items-center justify-between mb-2 gap-3">
          <h1 className="text-3xl md:text-4xl font-display tracking-widest neon-glow text-heading">THE ARCHITECT</h1>
          <div className="flex items-center gap-2 shrink-0">
            <HelpToggle />
            <BuildStamp />
            <Link to="/workspace" className="flex flex-col items-start gap-0.5 text-xs text-primary/60 hover:text-primary border border-primary/30 hover:border-primary/60 px-3 py-1.5 transition-colors shrink-0">
              <span className="flex items-center gap-1"><ArrowLeft size={14} /> <span className="hidden sm:inline">CONSTRUCTS</span></span>
              <span className="text-[9px] text-primary/75 tracking-wider hidden sm:block">// frontend</span>
            </Link>
          </div>
        </div>
        <p className="text-primary/60 mb-4 text-sm">// Standalone backend constructs — plan, generate, deploy independently</p>
        <div className="flex flex-col sm:flex-row gap-3 mb-8">
          <HelpHint id="new-backend" title="New Backend Construct" body="Create a standalone backend project. Add external sources (your frontend app files), then let Morpheus plan and generate the backend — database, API, auth. Deploy to Cloudflare, Supabase, Docker, and more.">
            <button onClick={() => setShowNew(true)} className="flex items-center gap-2 px-6 py-3 border border-primary text-primary hover:bg-primary hover:text-black transition-colors">
              <Plus size={18} /> NEW BACKEND
            </button>
          </HelpHint>
        </div>
        <PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} />
        <div className="flex gap-2 mb-3">
          <div className="flex-1 flex items-center gap-2 border border-primary/30 px-3 py-2">
            <Search size={14} className="text-primary/50 shrink-0" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search backends..."
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
        <div className="space-y-3" ref={listRef}>
          {loading && <p className="text-primary/75 italic">Loading constructs...</p>}
          {!loading && visibleProjects.length === 0 && (
            <p className="text-primary/75 italic">{search ? 'No backends match your search.' : 'No backend constructs found. The Matrix is empty. Create your first.'}</p>
          )}
          {visibleProjects.map(p => (
            <div key={p.id} className="relative group border border-primary/30 hover:border-primary hover:bg-primary/5 transition-colors">
              <button onClick={() => setSelectedProject(p)} className="w-full text-left p-4 pr-12">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server size={14} className="text-primary/60" />
                    <span className="text-primary group-hover:neon-glow">{p.name}</span>
                  </div>
                  <span className="text-xs text-primary/75 uppercase">{p.status}</span>
                </div>
                {p.description && <p className="text-primary/50 text-sm mt-1">{p.description}</p>}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setDeleteTarget(p); }}
                className="absolute top-3 right-3 text-primary/65 hover:text-red-500 transition-colors p-1"
                title="Delete construct"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </div>
      <NewBackendDialog
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreate={async (n, d, files) => { await createProject(n, d, files); setShowNew(false); }}
      />
      <BackendPanel
        open={!!selectedProject}
        onClose={() => { setSelectedProject(null); loadProjects(); }}
        project={selectedProject}
      />
      <DeleteConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        projectName={deleteTarget?.name}
        loading={deleting}
        onConfirm={async () => { setDeleting(true); try { await deleteProject(deleteTarget); setDeleteTarget(null); } finally { setDeleting(false); } }}
      />
    </div>
  );
}