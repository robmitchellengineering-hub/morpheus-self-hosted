import { useState, useEffect, useRef } from 'react';
import { Server, X, Loader2, CheckCircle, XCircle, Download, ExternalLink, FileCode, RefreshCw, Cloud, Database, Key, HardDrive, Zap, AlertTriangle, Link as LinkIcon, Bot, Globe, Zap as ZapIcon } from 'lucide-react';
import BackendPipelineRunner from './BackendPipelineRunner';
import SheetSelect from './SheetSelect';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import JSZip from 'jszip';
import HelpHint from './HelpHint';
import BackendConfigSection from './BackendConfigSection';
import ExternalSources from './ExternalSources';
import DiagnosisPanel, { DiagnosisLoading } from './DiagnosisPanel';
import { useDiagnosis } from '@/hooks/useDiagnosis';
import {
  COMPONENTS, DEFAULT_COMPONENTS, getServiceOption, hasCredentials,
  DELIVERY_POSTURES, postureOf, stackRequirement,
} from '../../../base44/shared/infrastructureComponents';
import { componentsForPosture, selectionSummary, selectionSentence, postureBadge } from '@/lib/postureChoice';

// Services that support live deploy (need credentials) vs ZIP-only vs code-level
const LIVE_DEPLOY_SERVICES = ['cloudflare-workers', 'vercel', 'netlify', 'railway', 'render', 'fly'];
const ZIP_ONLY_SERVICES = ['self-hosted-docker', 'standalone'];
const SQL_LIVE_SERVICES = ['supabase-pg']; // can execute SQL live if access token + project ref set
const SQL_MANUAL_SERVICES = ['neon', 'turso', 'planetscale'];
const CODE_LEVEL_SERVICES = ['supabase-auth', 'clerk', 'supabase-storage', 'r2', 'upstash'];

// Maps service option IDs (from infrastructureComponents) to connection keys
// (from ConnectionsSection). They differ for Cloudflare and Supabase.
const SERVICE_TO_CONN_KEY = {
  'cloudflare-workers': 'cloudflare',
  'vercel': 'vercel',
  'netlify': 'netlify',
  'railway': 'railway',
  'render': 'render',
  'fly': 'fly',
  'supabase-pg': 'supabase',
  'supabase-auth': 'supabase',
  'supabase-storage': 'supabase',
};

function checkCredentials(serviceId, connections) {
  return hasCredentials(serviceId, connections);
}

function getDeployExpectation(serviceId, connections) {
  if (LIVE_DEPLOY_SERVICES.includes(serviceId)) {
    return checkCredentials(serviceId, connections)
      ? { type: 'live', label: 'Live deploy ready' }
      : { type: 'needs-creds', label: 'Needs credentials' };
  }
  if (SQL_LIVE_SERVICES.includes(serviceId)) {
    const c = connections[serviceId] || {};
    if (c.access_token && c.project_ref) return { type: 'live', label: 'Live SQL deploy ready' };
    if (c.project_ref) return { type: 'partial', label: 'SQL ready (manual run)' };
    return { type: 'needs-creds', label: 'Needs credentials' };
  }
  if (ZIP_ONLY_SERVICES.includes(serviceId)) {
    return { type: 'zip', label: 'ZIP deploy (manual)' };
  }
  if (SQL_MANUAL_SERVICES.includes(serviceId)) {
    return { type: 'sql-manual', label: 'SQL ready (manual run)' };
  }
  if (CODE_LEVEL_SERVICES.includes(serviceId)) {
    return { type: 'code', label: 'Integrated in code' };
  }
  return { type: 'code', label: 'Integrated in code' };
}

const COMPONENT_ICONS = {
  api_host: Cloud,
  database: Database,
  auth: Key,
  file_storage: HardDrive,
  cache: Zap,
};

export default function BackendPanel({ open, onClose, project }) {
  const [phase, setPhase] = useState('idle');
  const [selectedComponents, setSelectedComponents] = useState(DEFAULT_COMPONENTS);
  // The whole-stack choice. Initialised from whatever DEFAULT_COMPONENTS describes rather than hardcoded,
  // so this feature changes nothing until an operator actually picks — and so it cannot silently
  // re-point the existing default path at a different stack.
  const [posture, setPosture] = useState(postureOf(DEFAULT_COMPONENTS));
  const [plan, setPlan] = useState(null);
  const [backendFiles, setBackendFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [error, setError] = useState(null);
  const [deployResults, setDeployResults] = useState([]);
  const [log, setLog] = useState([]);
  const [externalFiles, setExternalFiles] = useState([]);
  const [fetchingLogs, setFetchingLogs] = useState(false);
  const [platformLogs, setPlatformLogs] = useState(null);
  const [userConnections, setUserConnections] = useState({});
  const [wiring, setWiring] = useState(false);
  const [wireResult, setWireResult] = useState(null);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthResults, setHealthResults] = useState({});
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const { diagnosis, diagnosing, diagnose, clearDiagnosis } = useDiagnosis();
  const autoStarted = useRef(false);

  useEffect(() => {
    if (!open || !project) return;
    autoStarted.current = false;
    setPlan(null);
    setBackendFiles([]);
    setSelectedFile(null);
    setError(null);
    setDeployResults([]);
    setLog([]);
    setPlatformLogs(null);
    setUserConnections({});
    setWireResult(null);
    setHealthResults({});
    setHealthChecking(false);
    setPipelineRunning(false);
    clearDiagnosis();
    setPhase('loading');
    loadBackendState();
    loadConnections();
  }, [open, project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadConnections = async () => {
    try {
      const rows = await base44.entities.UserSettings.filter({}, '-updated_date', 1);
      if (rows[0]?.connections) {
        setUserConnections(JSON.parse(rows[0].connections));
      }
    } catch {}
  };

  const loadBackendState = async () => {
    try {
      const files = await base44.entities.ProjectFile.filter({ project_id: project.id });
      const planFile = files.find(f => f.path === 'backend/.plan.json');
      const bFiles = files.filter(f => f.path.startsWith('backend/') && f.path !== 'backend/.plan.json' && f.path !== 'backend/.deploy.json');
      const deployFile = files.find(f => f.path === 'backend/.deploy.json');
      const extFiles = files.filter(f => f.path.startsWith('external/'));
      setExternalFiles(extFiles);
      if (planFile) {
        const parsedPlan = JSON.parse(planFile.content);
        setPlan(parsedPlan);
        if (parsedPlan.components) {
          const suggestions = {};
          parsedPlan.components.forEach(c => { suggestions[c.type] = c.suggested; });
          setSelectedComponents({ ...DEFAULT_COMPONENTS, ...suggestions });
        }
        if (bFiles.length > 0) {
          setBackendFiles(bFiles);
          setSelectedFile(bFiles[0]);
          if (deployFile) {
            const deployInfo = JSON.parse(deployFile.content);
            setDeployResults(deployInfo.results || []);
            setPhase('deployed');
          } else {
            setPhase('generated');
          }
        } else {
          setPhase('plan-ready');
        }
      } else {
        if (!autoStarted.current) {
          if (project.project_type !== 'backend' || extFiles.length > 0) {
            autoStarted.current = true;
            startPlanning();
          } else {
            setPhase('idle');
          }
        }
      }
    } catch (e) {
      setError(e.message);
      setPhase('error');
    }
  };

  const refreshExternal = async () => {
    const files = await base44.entities.ProjectFile.filter({ project_id: project.id });
    setExternalFiles(files.filter(f => f.path.startsWith('external/')));
  };

  const startPlanning = async () => {
    setPhase('planning');
    setLog(prev => [...prev, '> Analyzing project and planning infrastructure...']);
    try {
      // The posture travels with the plan request: the architect is told which stack to plan for, and the
      // plan comes back stamped with it so what the operator reviews is what was planned for.
      const res = await base44.functions.invoke('planBackend', { projectId: project.id, posture: posture || undefined });
      setPlan(res.data.plan);
      if (res.data.plan?.components) {
        const suggestions = {};
        res.data.plan.components.forEach(c => { suggestions[c.type] = c.suggested; });
        setSelectedComponents({ ...DEFAULT_COMPONENTS, ...suggestions });
      }
      setPhase('plan-ready');
      setLog(prev => [...prev, '> Plan generated. Review infrastructure selections and generate backend.']);
    } catch (e) {
      setError(e.message);
      setPhase('error');
    }
  };

  const generateBackend = async () => {
    setPhase('generating');
    const labels = Object.entries(selectedComponents)
      .map(([type, id]) => getServiceOption(type, id)?.label || id)
      .filter(l => l)
      .join(' + ');
    setLog(prev => [...prev, `> Generating backend code: ${labels}...`]);
    try {
      const res = await base44.functions.invoke('generateBackend', { projectId: project.id, components: selectedComponents });
      const files = await base44.entities.ProjectFile.filter({ project_id: project.id });
      const bFiles = files.filter(f => f.path.startsWith('backend/') && f.path !== 'backend/.plan.json');
      setBackendFiles(bFiles);
      setSelectedFile(bFiles[0] || null);
      setPhase('generated');
      setLog(prev => [...prev, `> Generated ${bFiles.length} backend files.`, res.data.summary || '']);
    } catch (e) {
      setError(e.message);
      setPhase('error');
    }
  };

  const deployBackend = async () => {
    setPhase('deploying');
    setPlatformLogs(null);
    const labels = Object.entries(selectedComponents)
      .map(([type, id]) => getServiceOption(type, id)?.label || id)
      .filter(l => l)
      .join(' + ');
    setLog(prev => [...prev, `> Deploying all components: ${labels}...`]);
    try {
      const res = await base44.functions.invoke('deployBackend', { projectId: project.id, components: selectedComponents });
      const results = res.data.results || [];
      setDeployResults(results);
      const deployedCount = results.filter(r => r.status === 'deployed').length;
      const errorCount = results.filter(r => r.status === 'error').length;
      const sqlReadyCount = results.filter(r => r.status === 'sql-ready').length;
      setLog(prev => [...prev, `> Deploy complete: ${deployedCount} live, ${sqlReadyCount} SQL-ready, ${errorCount} errors.`]);
      setPhase('deployed');
    } catch (e) {
      setError(e.message);
      setPhase('error');
    }
  };

  const fetchLogs = async (platform) => {
    setFetchingLogs(true);
    setPlatformLogs(null);
    setLog(prev => [...prev, `> Fetching logs from ${platform}...`]);
    try {
      const res = await base44.functions.invoke('getBackendLogs', { projectId: project.id, platform });
      setPlatformLogs(res.data);
      setLog(prev => [...prev, `> Logs retrieved from ${res.data.platform}.`]);
    } catch (e) {
      setError(e.message);
      setPhase('error');
    } finally {
      setFetchingLogs(false);
    }
  };

  const wireFrontend = async () => {
    setWiring(true);
    setWireResult(null);
    setLog(prev => [...prev, '> Wiring frontend to live backend...']);
    try {
      const res = await base44.functions.invoke('wireFrontendToBackend', { projectId: project.id });
      setWireResult(res.data);
      if (res.data.filesChanged > 0) {
        setLog(prev => [...prev, `> ${res.data.message}`]);
      } else {
        setLog(prev => [...prev, `> ${res.data.message}`]);
      }
    } catch (e) {
      setError(e.message);
      setLog(prev => [...prev, `> Wire failed: ${e.message}`]);
    } finally {
      setWiring(false);
    }
  };

  const checkHealth = async () => {
    setHealthChecking(true);
    setHealthResults({});
    setLog(prev => [...prev, '> Running health check on deployed services...']);
    try {
      const res = await base44.functions.invoke('checkDeployHealth', { projectId: project.id });
      const health = res.data;
      // Map by service for display
      const byService = {};
      if (health.url) byService._auto = health;
      setHealthResults(byService);
      if (health.healthy) {
        setLog(prev => [...prev, `> Health check PASSED: ${health.url} (${health.statusCode}, ${health.responseTimeMs}ms)`]);
      } else {
        setLog(prev => [...prev, `> Health check FAILED: ${health.error || health.statusCode || 'unreachable'}`]);
      }
    } catch (e) {
      setError(e.message);
      setLog(prev => [...prev, `> Health check error: ${e.message}`]);
    } finally {
      setHealthChecking(false);
    }
  };

  const diagnoseAndFix = async () => {
    setLog(prev => [...prev, '> AI agent analyzing deploy errors and attempting auto-fix...']);
    const result = await diagnose({
      type: 'deploy',
      projectId: project.id,
      errorContext: deployResults,
      components: selectedComponents
    });
    if (result?.autoFixed?.length > 0) {
      setLog(prev => [...prev, `> Auto-fixed ${result.autoFixed.length} issue(s). Review and redeploy.`]);
      const files = await base44.entities.ProjectFile.filter({ project_id: project.id });
      const bFiles = files.filter(f => f.path.startsWith('backend/') && f.path !== 'backend/.plan.json' && f.path !== 'backend/.deploy.json');
      setBackendFiles(bFiles);
      if (selectedFile) {
        const updated = bFiles.find(f => f.id === selectedFile.id);
        if (updated) setSelectedFile(updated);
      }
    }
    if (result?.needsUserAction?.length > 0) {
      setLog(prev => [...prev, `> ${result.needsUserAction.length} issue(s) need your action — see diagnosis below.`]);
    }
  };

  const downloadZip = async () => {
    const allFiles = await base44.entities.ProjectFile.filter({ project_id: project.id });
    const zip = new JSZip();
    allFiles.forEach(f => {
      if (f.path !== 'backend/.plan.json') zip.file(f.path, f.content);
    });
    const slug = project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}-backend.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!open) return null;

  const sortedFiles = [...backendFiles].sort((a, b) => a.path.localeCompare(b.path));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 md:p-4">
      <div className="w-full max-w-4xl h-[90vh] border border-primary/40 bg-background shadow-[0_0_20px_rgba(0,255,65,0.2)] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <Server size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider neon-glow text-sm md:text-base">BACKEND DEVELOPMENT</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-4">
          {/* Connections status banner — shows when live-deploy components lack credentials */}
          {userConnections && (() => {
            const missing = Object.entries(selectedComponents).map(([type, serviceId]) => {
              const exp = getDeployExpectation(serviceId, userConnections);
              return exp.type === 'needs-creds' ? { type, serviceId, ...exp } : null;
            }).filter(Boolean);
            if (missing.length === 0) return null;
            return (
              <div className="border border-yellow-500/40 bg-yellow-500/5 p-3 flex items-start gap-2">
                <AlertTriangle size={16} className="text-yellow-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-yellow-500 text-sm font-bold">CONNECTIONS REQUIRED</p>
                  <p className="text-xs text-ink-strong mt-0.5">
                    {missing.length} component{missing.length > 1 ? 's' : ''} need credentials before live deploy will work: {missing.map(m => getServiceOption(m.type, m.serviceId)?.label || m.serviceId).join(', ')}.
                  </p>
                  <Link to="/settings" className="inline-flex items-center gap-1 text-xs text-primary hover:underline border border-primary/30 hover:border-primary/60 px-2 py-1.5 mt-2">
                    <LinkIcon size={10} /> GO TO SETTINGS → CONNECTIONS
                  </Link>
                </div>
              </div>
            );
          })()}

          {/* Planning / Loading */}
          {(phase === 'planning' || phase === 'loading') && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 size={32} className="animate-spin text-primary/60" />
              <p className="text-ink text-sm font-mono text-center px-4">Morpheus is analyzing your project and planning the backend...</p>
            </div>
          )}

          {/* Idle — upload external sources before planning (standalone backend) */}
          {phase === 'idle' && (
            <div className="space-y-3">
              <div className="border border-primary/20 p-3">
                <p className="text-ink text-sm mb-1">Upload your existing app or files, and Morpheus will analyze them to plan the backend.</p>
                <p className="text-ink-strong text-xs">You can upload frontend source files, API specs, database schemas, or any reference code. When ready, hit PLAN BACKEND.</p>
              </div>
              <ExternalSources projectId={project.id} externalFiles={externalFiles} onRefresh={refreshExternal} />
            </div>
          )}

          {/* Plan display */}
          {plan && phase !== 'planning' && phase !== 'loading' && (
            <div className="border border-primary/20 p-3">
              <div className="text-xs text-primary/75 uppercase mb-2">// architecture plan</div>
              <p className="text-ink text-sm mb-3">{plan.summary}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {plan.database?.tables?.length > 0 && (
                  <div><span className="text-ink-strong">DB Tables: </span><span className="text-ink-strong">{plan.database.tables.map(t => t.name).join(', ')}</span></div>
                )}
                {plan.api?.routes?.length > 0 && (
                  <div><span className="text-ink-strong">API Routes: </span><span className="text-ink-strong">{plan.api.routes.length} endpoints</span></div>
                )}
                <div><span className="text-ink-strong">Auth: </span><span className="text-ink-strong">{plan.auth?.strategy || 'none'}</span></div>
                <div><span className="text-ink-strong">Storage: </span><span className="text-ink-strong">{plan.storage?.type || 'none'}</span></div>
              </div>
              {plan.recommendations && <p className="text-xs text-ink-strong italic mt-2">{plan.recommendations}</p>}
            </div>
          )}

          {/* Where it runs — the whole stack in one decision, above the per-service list because the
              services are not independent choices: a self-hosted API over a cloud database is not a
              leaner stack, it is one that cannot run. */}
          {phase === 'idle' && (
            <div>
              <div className="text-xs text-primary/75 uppercase mb-2">// where should this run?</div>
              <div className="space-y-2">
                {DELIVERY_POSTURES.map((p) => {
                  const active = posture === p.id;
                  const badge = postureBadge(selectionSummary({ components: p.components, postureOf, stackRequirement }));
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        // Two statements, not a `||` chain: setPosture returns undefined, so
                        // `setPosture(x) || setSelectedComponents(...)` never ran the second call — a
                        // handler that looked like it did two things and did one.
                        const next = componentsForPosture(p);
                        if (!next) return;
                        setPosture(p.id);
                        setSelectedComponents(next);
                      }}
                      className={`w-full text-left border p-2.5 transition-colors ${active ? 'border-primary bg-primary/10' : 'border-primary/20 hover:border-primary/50'}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-ink font-medium">{p.label}</span>
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-ink-max/20 text-ink-max">
                          {badge}
                        </span>
                      </div>
                      <div className="text-xs text-ink-strong mt-1">{p.summary}</div>
                      <div className="text-[11px] text-ink-max mt-1.5">{p.guarantee}</div>
                      <div className="text-[11px] text-ink-max mt-1">{p.tradeoff}</div>
                    </button>
                  );
                })}
              </div>
              <div className="text-[11px] text-ink-max mt-1.5">
                Pick one and the connections below are set to match. You can still change any of them —
                but a stack that mixes self-hosted and managed services may not run without those accounts.
              </div>
            </div>
          )}

          {/* Infrastructure component selection */}
          {(phase === 'plan-ready' || phase === 'generated') && (
            <div>
              <div className="text-xs text-primary/75 uppercase mb-2">// infrastructure connections — auto-suggested, change as needed</div>
              {/* The sentence that was missing when the default stack quietly put an operator's data in
                  a cloud account: the services were all listed, and nothing ever added them up. The
                  wording and the rules live in src/lib/postureChoice.js, where they are tested. */}
              <div className="text-[11px] text-ink-max mb-2">
                {selectionSentence(selectionSummary({ components: selectedComponents, postureOf, stackRequirement }))}
              </div>
              <div className="space-y-2">
                {COMPONENTS.map(comp => {
                  const Icon = COMPONENT_ICONS[comp.type] || Server;
                  const selectedId = selectedComponents[comp.type];
                  const selectedService = getServiceOption(comp.type, selectedId);
                  const planSuggestion = plan?.components?.find(c => c.type === comp.type);
                  const isAutoSelected = planSuggestion && planSuggestion.suggested === selectedId;
                  return (
                    <div key={comp.type} className="border border-primary/20 p-2.5">
                      <div className="flex items-start gap-2">
                        <Icon size={16} className="text-primary shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-ink text-sm">{comp.label}</span>
                            {isAutoSelected && <span className="text-[9px] text-primary/75 border border-primary/30 px-1 uppercase">auto</span>}
                            {!comp.required && <span className="text-[9px] text-primary/65 uppercase">optional</span>}
                          </div>
                          <div className="text-ink-strong text-xs">{comp.description}</div>
                          {selectedService && <div className="text-ink-strong text-xs mt-0.5">Free: {selectedService.freeTier}</div>}
                          {planSuggestion?.reason && <div className="text-ink-strong text-xs italic mt-0.5">{planSuggestion.reason}</div>}
                        </div>
                        <SheetSelect
                          value={selectedId}
                          onChange={(v) => setSelectedComponents(prev => ({ ...prev, [comp.type]: v }))}
                          label={comp.label.toUpperCase()}
                          options={comp.options.map(o => ({ value: o.id, label: o.label }))}
                          triggerClassName="text-xs px-2 py-1.5 shrink-0 max-w-[140px]"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* External sources — upload/paste external apps or files */}
          {(phase === 'plan-ready' || phase === 'generated') && (
            <ExternalSources projectId={project.id} externalFiles={externalFiles} onRefresh={refreshExternal} />
          )}

          {/* Generating */}
          {phase === 'generating' && (
            <div className="flex items-center gap-2 text-ink text-sm"><Loader2 size={16} className="animate-spin" /> Generating backend code for selected infrastructure...</div>
          )}

          {/* Pre-deploy readiness check */}
          {phase === 'generated' && (() => {
            const readiness = Object.entries(selectedComponents).map(([type, serviceId]) => {
              const exp = getDeployExpectation(serviceId, userConnections);
              return { type, serviceId, ...exp };
            });
            const needsCreds = readiness.filter(r => r.type === 'needs-creds');
            const hasLive = readiness.some(r => r.type === 'live');
            return (
              <div className={`border p-3 ${needsCreds.length > 0 ? 'border-yellow-500/40 bg-yellow-500/5' : 'border-primary/20'}`}>
                <div className="text-xs text-primary/75 uppercase mb-2 flex items-center gap-1.5">
                  {needsCreds.length > 0 ? <AlertTriangle size={12} className="text-yellow-500" /> : <CheckCircle size={12} className="text-primary" />}
                  // deploy readiness
                </div>
                {needsCreds.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs text-yellow-500/80">
                      {needsCreds.length} component{needsCreds.length > 1 ? 's' : ''} need credentials before live deploy. Without them, deploy will return ZIP/error instructions instead of going live.
                    </p>
                    <div className="space-y-1">
                      {needsCreds.map(r => {
                        const service = getServiceOption(r.type, r.serviceId);
                        return (
                          <div key={r.type} className="flex items-center gap-2 text-xs">
                            <AlertTriangle size={10} className="text-yellow-500 shrink-0" />
                            <span className="text-ink-strong">{service?.label || r.serviceId}</span>
                            <span className="text-yellow-500/60">— {r.label}</span>
                          </div>
                        );
                      })}
                    </div>
                    <Link to="/settings" className="inline-flex items-center gap-1 text-xs text-primary hover:underline border border-primary/30 hover:border-primary/60 px-2 py-1.5 mt-1">
                      <LinkIcon size={10} /> GO TO SETTINGS → CONNECTIONS
                    </Link>
                    <p className="text-[10px] text-ink-max mt-1">
                      // Or click DEPLOY anyway to get ZIP download + manual instructions for each component.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p className="text-xs text-ink-strong">
                      {hasLive ? 'All live-deploy components have credentials. Deploy will push code live.' : 'Components are ready. Deploy will generate ZIP packages and SQL migrations for manual deployment.'}
                    </p>
                    {readiness.filter(r => r.type === 'zip').length > 0 && (
                      <p className="text-[10px] text-ink-max">
                        // {readiness.filter(r => r.type === 'zip').map(r => getServiceOption(r.type, r.serviceId)?.label).join(', ')} — ZIP deploy only (manual upload to platform).
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Custom Domain & API Key Management — available pre-deploy and post-deploy */}
          {(phase === 'generated' || phase === 'deployed') && (
            <BackendConfigSection projectId={project.id} apiHostService={selectedComponents.api_host} />
          )}

          {/* Backend files */}
          {phase === 'generated' && backendFiles.length > 0 && (
            <div>
              <div className="text-xs text-primary/75 uppercase mb-2">// backend files ({backendFiles.length})</div>

              {/* Mobile: stacked layout with select dropdown */}
              <div className="md:hidden border border-primary/20">
                <div className="border-b border-primary/20 p-2">
                  <SheetSelect
                    value={selectedFile?.id || ''}
                    onChange={(v) => setSelectedFile(backendFiles.find(f => f.id === v))}
                    label="BACKEND FILES"
                    options={sortedFiles.map(f => ({ value: f.id, label: f.path.replace('backend/', '') }))}
                    triggerClassName="w-full text-xs px-2 py-1.5"
                  />
                </div>
                <div className="overflow-y-auto scrollbar-matrix max-h-64">
                  {selectedFile ? <pre className="text-xs text-ink-strong p-3 whitespace-pre-wrap font-mono break-all">{selectedFile.content}</pre> : <div className="p-3 text-ink-strong text-xs">Select a file</div>}
                </div>
              </div>

              {/* Desktop: side-by-side layout */}
              <div className="hidden md:flex border border-primary/20 max-h-64">
                <div className="w-1/3 border-r border-primary/20 overflow-y-auto scrollbar-matrix">
                  {sortedFiles.map(f => (
                    <button key={f.id} onClick={() => setSelectedFile(f)} className={`w-full text-left flex items-center gap-1 px-2 py-1.5 text-xs ${selectedFile?.id === f.id ? 'bg-primary/10 text-primary' : 'text-primary/60 hover:text-primary'}`}>
                      <FileCode size={12} className="shrink-0" /><span className="truncate">{f.path.replace('backend/', '')}</span>
                    </button>
                  ))}
                </div>
                <div className="flex-1 overflow-y-auto scrollbar-matrix">
                  {selectedFile ? <pre className="text-xs text-ink-strong p-3 whitespace-pre-wrap font-mono break-all">{selectedFile.content}</pre> : <div className="p-3 text-ink-strong text-xs">Select a file</div>}
                </div>
              </div>
            </div>
          )}

          {/* Deploying */}
          {phase === 'deploying' && <div className="flex items-center gap-2 text-ink text-sm"><Loader2 size={16} className="animate-spin" /> Deploying all components to their platforms...</div>}

          {/* Deployed — per-component results */}
          {phase === 'deployed' && deployResults.length > 0 && (() => {
            const liveCount = deployResults.filter(r => r.status === 'deployed').length;
            const errorCount = deployResults.filter(r => r.status === 'error').length;
            const manualCount = deployResults.filter(r => r.status === 'zip' || r.status === 'sql-ready' || r.status === 'integrated').length;
            return (
            <div className="space-y-3">
              {liveCount === 0 && errorCount > 0 && (
                <div className="border border-yellow-500/40 bg-yellow-500/5 p-3">
                  <div className="flex items-center gap-2 text-yellow-500 text-sm mb-1"><AlertTriangle size={16} /> No components deployed live.</div>
                  <p className="text-xs text-ink-strong">
                    {errorCount} component{errorCount > 1 ? 's need' : ' needs'} credentials, {manualCount} are ZIP/manual/code-level. To go live: add credentials in <Link to="/settings" className="text-primary hover:underline">Settings → Connections</Link>, then click DEPLOY again. Or download the ZIP for manual deployment.
                  </p>
                </div>
              )}
              <div className="flex items-center gap-2 text-ink text-sm"><CheckCircle size={16} /> Deployment complete — review each component:</div>
              {deployResults.map((r, i) => (
                <div key={i} className={`border p-3 ${r.status === 'deployed' ? 'border-primary/40 bg-primary/5' : r.status === 'error' ? 'border-red-500/40 bg-red-500/5' : 'border-primary/20'}`}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      {r.status === 'deployed' ? <CheckCircle size={14} className="text-primary" /> : r.status === 'error' ? <XCircle size={14} className="text-red-500" /> : <FileCode size={14} className="text-primary/60" />}
                      <span className="text-primary text-sm font-bold uppercase">{r.component}</span>
                      {r.label && <span className="text-ink-strong text-xs">— {r.label}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      {r.healthStatus && (
                        <span className={`text-[10px] uppercase px-1.5 py-0.5 border ${
                          r.healthStatus === 'healthy' ? 'text-primary border-primary/40' :
                          r.healthStatus === 'building' ? 'text-yellow-500 border-yellow-500/40' :
                          'text-red-500 border-red-500/40'
                        }`}>
                          {r.healthStatus === 'healthy' ? '● HEALTHY' : r.healthStatus === 'building' ? '◐ BUILDING' : '○ UNHEALTHY'}
                        </span>
                      )}
                      <span className={`text-xs uppercase ${r.status === 'deployed' ? 'text-primary' : r.status === 'error' ? 'text-red-500' : 'text-primary/50'}`}>{r.status}</span>
                    </div>
                  </div>
                  {r.message && <p className="text-xs text-ink-strong mb-1">{r.message}</p>}
                  {r.url && (
                    <a href={r.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline mb-1">
                      <ExternalLink size={12} /> {r.url.length > 60 ? r.url.substring(0, 60) + '...' : r.url}
                    </a>
                  )}
                  {r.customDomain && (
                    <div className="flex items-center gap-1 text-xs text-ink-strong mb-1">
                      <Globe size={12} /> Custom domain: <span className="text-ink-strong">{r.customDomain}</span>
                    </div>
                  )}
                  {r.apiKeysInjected && (
                    <div className="flex items-center gap-1 text-xs text-ink-strong mb-1">
                      <Key size={12} /> API keys injected as env var
                    </div>
                  )}
                  {r.configMessage && (
                    <div className="mt-1.5 border border-yellow-500/30 bg-yellow-500/5 p-2">
                      <div className="flex items-center gap-1 text-yellow-500 text-[10px] uppercase mb-1">
                        <AlertTriangle size={10} /> Manual setup required
                      </div>
                      {r.configMessage.replace(/^Manual:\s*/, '').split(' | ').map((step, i) => (
                        <div key={i} className="text-[10px] text-ink-max font-mono leading-relaxed">{step}</div>
                      ))}
                    </div>
                  )}
                  {r.sql && (
                    <details className="mt-1">
                      <summary className="text-xs text-primary/50 cursor-pointer hover:text-primary">View SQL migration</summary>
                      <pre className="text-xs text-ink-strong whitespace-pre-wrap mt-1 max-h-32 overflow-y-auto scrollbar-matrix border border-primary/10 p-2">{r.sql}</pre>
                    </details>
                  )}
                  {r.status === 'deployed' && (r.service === 'cloudflare-workers' || r.service === 'supabase-pg' || r.service === 'render' || r.service === 'vercel' || r.service === 'netlify') && (
                    <button onClick={() => fetchLogs(r.service)} disabled={fetchingLogs} className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary border border-primary/30 hover:border-primary/60 px-2 py-1 mt-2 transition-colors disabled:opacity-30">
                      {fetchingLogs ? <Loader2 size={12} className="animate-spin" /> : <FileCode size={12} />} VIEW LOGS
                    </button>
                  )}
                </div>
              ))}
              {/* Platform logs display */}
              {platformLogs && (
                <div className="border border-primary/20 p-2 bg-primary/5">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-primary/75 uppercase">// logs: {platformLogs.platform}</span>
                    {platformLogs.dashboardUrl && <a href={platformLogs.dashboardUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline"><ExternalLink size={10} /> dashboard</a>}
                  </div>
                  <div className="max-h-48 overflow-y-auto scrollbar-matrix">
                    {(platformLogs.logs || []).map((l, i) => <div key={i} className="text-xs text-ink-strong font-mono whitespace-pre-wrap">{l}</div>)}
                  </div>
                </div>
              )}
            </div>
            );
          })()}

          {/* Frontend ↔ Backend Auto-Wire Result */}
          {wireResult && !wiring && (
            <div className={`border p-3 ${wireResult.error ? 'border-red-500/40 bg-red-500/5' : 'border-primary/40 bg-primary/5'}`}>
              <div className="flex items-center gap-2 mb-1">
                <Zap size={14} className={wireResult.error ? 'text-red-500' : 'text-primary'} />
                <span className={`text-sm font-bold uppercase ${wireResult.error ? 'text-red-500' : 'text-primary'}`}>FRONTEND WIRE</span>
              </div>
              {wireResult.error ? (
                <p className="text-xs text-red-500/80">{wireResult.error}</p>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-xs text-ink-strong">{wireResult.message}</p>
                  {wireResult.apiUrl && (
                    <a href={wireResult.apiUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline">
                      <ExternalLink size={10} /> {wireResult.apiUrl}
                    </a>
                  )}
                  {wireResult.changes?.length > 0 && (
                    <div className="space-y-0.5 mt-1">
                      <div className="text-[10px] text-primary/75 uppercase">// updated files</div>
                      {wireResult.changes.map((c, i) => (
                        <div key={i} className="text-xs text-ink-strong font-mono">
                          {c.path} — {c.replacements} replacement{c.replacements > 1 ? 's' : ''}
                        </div>
                      ))}
                    </div>
                  )}
                  {wireResult.configPath && (
                    <div className="text-[10px] text-ink-max mt-1">
                      // config: {wireResult.configPath} — import {'{ API_BASE_URL }'} from this file
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* AI Diagnosis & Auto-Fix Results (shared component) */}
          {diagnosing && <DiagnosisLoading label="AI AGENT ANALYZING DEPLOY ERRORS..." />}
          {diagnosis && !diagnosing && (
            <DiagnosisPanel diagnosis={diagnosis} onRedeploy={deployBackend} redeployLabel="REDEPLOY" />
          )}

          {/* Error */}
          {phase === 'error' && <div className="flex items-center gap-2 text-red-500 text-sm"><XCircle size={16} /> {error}</div>}

          {/* Log */}
          {log.length > 0 && (
            <div className="border border-primary/10 p-2 bg-primary/5">
              <div className="text-xs text-primary/65 uppercase mb-1">// log</div>
              {log.map((l, i) => <div key={i} className="text-xs text-ink-strong font-mono">{l}</div>)}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-primary/20 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex items-center justify-between gap-2 shrink-0">
          <div className="text-xs text-ink-strong capitalize">{phase}</div>
          <div className="flex items-center gap-2">
            {phase === 'idle' && (
              <button onClick={startPlanning} disabled={phase === 'planning'} className="flex items-center gap-1 px-4 py-2 border border-primary text-primary hover:bg-primary hover:text-black transition-colors text-sm font-bold">
                <Server size={14} /> PLAN BACKEND
              </button>
            )}
            {phase === 'plan-ready' && (
              <>
                <button onClick={startPlanning} className="flex items-center gap-1 text-xs text-primary/60 hover:text-primary px-3 py-2"><RefreshCw size={12} /> RE-ARCHITECT</button>
                <HelpHint id="backend-generate" title="Generate Backend" body="Generates production-ready backend code for all selected infrastructure components. Morpheus writes the server, database schema, API routes, auth, storage, and config files — all connected to your chosen free-tier services.">
                  <button onClick={generateBackend} className="flex items-center gap-1 px-4 py-2 border border-primary text-primary hover:bg-primary hover:text-black transition-colors text-sm font-bold">GENERATE BACKEND</button>
                </HelpHint>
              </>
            )}
            {phase === 'generated' && (
              <>
                <HelpHint id="backend-deploy" title="Deploy Backend" body="Deploys all components: executes database migrations on Supabase, live-deploys API to Cloudflare Workers, and returns dashboard links for every platform so you can verify execution.">
                  <button onClick={deployBackend} className="flex items-center gap-1 px-4 py-2 border border-primary text-primary hover:bg-primary hover:text-black transition-colors text-sm font-bold"><Cloud size={14} /> DEPLOY</button>
                </HelpHint>
                <HelpHint id="backend-auto-deploy" title="Auto-Deploy Pipeline" body="Fully automated loop: deploy → health check → if unhealthy, AI diagnose and auto-fix → redeploy. Runs up to 8 iterations with a live timer and stop button.">
                  <button onClick={() => setPipelineRunning(true)} className="flex items-center gap-1 px-3 py-2 border border-primary/60 text-primary/80 hover:border-primary hover:text-primary hover:bg-primary/10 transition-colors text-sm font-bold"><ZapIcon size={14} /> AUTO</button>
                </HelpHint>
                <HelpHint id="backend-download" title="Download ZIP" body="Downloads all project files (frontend + backend) as a ZIP. For Docker: run docker-compose up. For Standalone: run npm install && npm start.">
                  <button onClick={downloadZip} className="flex items-center gap-1 text-xs text-primary/60 hover:text-primary px-3 py-2"><Download size={14} /> ZIP</button>
                </HelpHint>
                <button onClick={() => setPhase('plan-ready')} className="flex items-center gap-1 text-xs text-primary/60 hover:text-primary px-3 py-2"><RefreshCw size={12} /> REGENERATE</button>
                <button onClick={startPlanning} className="flex items-center gap-1 text-xs text-primary/60 hover:text-primary px-3 py-2"><RefreshCw size={12} /> RE-ARCHITECT</button>
              </>
            )}
            {phase === 'deployed' && (
              <>
                <button onClick={checkHealth} disabled={healthChecking} className="flex items-center gap-1 text-xs text-primary hover:text-black hover:bg-primary px-3 py-2 border border-primary disabled:opacity-30 transition-colors font-bold">
                  {healthChecking ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />} CHECK HEALTH
                </button>
                <button onClick={wireFrontend} disabled={wiring} className="flex items-center gap-1 text-xs text-primary hover:text-black hover:bg-primary px-3 py-2 border border-primary disabled:opacity-30 transition-colors font-bold">
                  {wiring ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />} WIRE TO FRONTEND
                </button>
                <button onClick={diagnoseAndFix} disabled={diagnosing} className="flex items-center gap-1 text-xs text-primary hover:text-primary px-3 py-2 border border-primary/50 hover:border-primary disabled:opacity-30">
                  {diagnosing ? <Loader2 size={12} className="animate-spin" /> : <Bot size={12} />} AI DIAGNOSE & FIX
                </button>
                <button onClick={deployBackend} className="flex items-center gap-1 text-xs text-primary hover:text-primary px-3 py-2 border border-primary/30 hover:border-primary/60">
                  <RefreshCw size={12} /> REDEPLOY
                </button>
                <button onClick={() => fetchLogs(selectedComponents.api_host)} disabled={fetchingLogs} className="flex items-center gap-1 text-xs text-primary/60 hover:text-primary px-3 py-2 disabled:opacity-30">
                  {fetchingLogs ? <Loader2 size={12} className="animate-spin" /> : <FileCode size={12} />} VIEW LOGS
                </button>
                <button onClick={onClose} className="text-xs text-primary/60 hover:text-primary px-3 py-2">CLOSE</button>
              </>
            )}
          </div>
        </div>

        {pipelineRunning && (
          <BackendPipelineRunner
            project={project}
            selectedComponents={selectedComponents}
            onClose={() => setPipelineRunning(false)}
            onComplete={async () => {
              await loadBackendState();
            }}
          />
        )}
      </div>
    </div>
  );
}