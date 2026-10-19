import { useState, useEffect, useCallback } from 'react';
import { api } from './api.js';

// Self-contained, themeable config + deploy panel. No external UI deps.
// Mount it with a projectId, or leave null to show the project picker.

const CSS = `
.architect{--bg:#0a0a0a;--fg:#00ff41;--muted:#4a8a5a;--border:#1a3a22;--danger:#ff4d4d;--warn:#ffcc00;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);background:var(--bg);
  border:1px solid var(--border);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;max-height:90vh}
.architect *{box-sizing:border-box}
.architect header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);font-weight:700;letter-spacing:.08em}
.architect header button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px}
.architect .body{padding:14px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:12px}
.architect .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.architect input,.architect select,.architect textarea{background:#000;color:var(--fg);border:1px solid var(--border);
  border-radius:4px;padding:6px 8px;font:inherit;font-size:12px;outline:none}
.architect input:focus,.architect select:focus,.architect textarea:focus{border-color:var(--fg)}
.architect textarea{width:100%;min-height:60px;resize:vertical}
.architect button.btn{background:#000;color:var(--fg);border:1px solid var(--fg);border-radius:4px;padding:7px 14px;
  font:inherit;font-weight:700;font-size:12px;cursor:pointer;letter-spacing:.05em}
.architect button.btn:hover{background:var(--fg);color:#000}
.architect button.btn.sec{border-color:var(--border)}
.architect button.btn.sec:hover{border-color:var(--fg);background:transparent;color:var(--fg)}
.architect button.btn:disabled{opacity:.4;cursor:not-allowed}
.architect .card{border:1px solid var(--border);border-radius:6px;padding:10px}
.architect .card.warn{border-color:var(--warn);background:rgba(255,204,0,.05)}
.architect .card.err{border-color:var(--danger);background:rgba(255,77,77,.05)}
.architect .card.ok{border-color:var(--fg);background:rgba(0,255,65,.05)}
.architect .label{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:.08em;margin-bottom:6px}
.architect .tag{font-size:10px;border:1px solid var(--border);padding:1px 5px;border-radius:3px;text-transform:uppercase}
.architect .tag.live{color:var(--fg);border-color:var(--fg)}
.architect .tag.creds{color:var(--warn);border-color:var(--warn)}
.architect .tag.zip{color:var(--muted)}
.architect .log{border:1px solid var(--border);background:rgba(0,255,65,.04);padding:8px;font-size:11px;max-height:160px;overflow-y:auto}
.architect .log div{white-space:pre-wrap}
.architect .files{display:flex;border:1px solid var(--border);max-height:220px}
.architect .files .tree{width:38%;border-right:1px solid var(--border);overflow-y:auto}
.architect .files .tree button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--muted);padding:5px 8px;font:inherit;font-size:11px;cursor:pointer}
.architect .files .tree button.active{background:rgba(0,255,65,.1);color:var(--fg)}
.architect .files .view{flex:1;overflow-y:auto;padding:8px;font-size:11px;white-space:pre-wrap}
.architect .phase{font-size:11px;color:var(--muted);text-transform:capitalize}
.architect .spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--fg);border-radius:50%;animation:archspin .7s linear infinite}
@keyframes archspin{to{transform:rotate(360deg)}}
.architect a{color:var(--fg)}
`;

export default function ArchitectPanel({ projectId: initialId, onClose }) {
  const [catalog, setCatalog] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(initialId || null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [frontendConfig, setFrontendConfig] = useState('{}');
  const [connections, setConnections] = useState('{}');
  const [components, setComponents] = useState(null);
  const [plan, setPlan] = useState(null);
  const [files, setFiles] = useState([]);
  const [selFile, setSelFile] = useState(null);
  const [deployResults, setDeployResults] = useState([]);
  const [phase, setPhase] = useState('idle');
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState(null);

  useEffect(() => { if (!document.getElementById('architect-css')) { const s = document.createElement('style'); s.id = 'architect-css'; s.textContent = CSS; document.head.appendChild(s); } }, []);
  useEffect(() => { api.catalog().then(setCatalog).catch(() => {}); }, []);
  useEffect(() => { if (!initialId) api.listProjects().then(setProjects).catch(() => {}); }, [initialId]);

  const addLog = (m) => setLog((p) => [...p.slice(-30), `${new Date().toLocaleTimeString()} ${m}`]);
  const ensureComponents = useCallback(async (id) => {
    if (!catalog) return;
    const r = await api.readiness(id);
    const map = {};
    r.forEach((x) => (map[x.type] = x.serviceId));
    setComponents(map);
  }, [catalog]);

  useEffect(() => { if (projectId) { ensureComponents(projectId); } }, [projectId, ensureComponents]);

  const create = async () => {
    setBusy(true); addLog('Creating project…');
    try {
      const p = await api.createProject({ name: name || 'Untitled', description: desc, frontendConfig: JSON.parse(frontendConfig), connections: JSON.parse(connections) });
      setProjectId(p.id); setPhase('plan-ready'); addLog(`Project ${p.id} created.`);
    } catch (e) { addLog(`Error: ${e.message}`); }
    setBusy(false);
  };

  const runPlan = async () => { setBusy(true); setPhase('planning'); addLog('Planning backend…'); try { const pl = await api.plan(projectId); setPlan(pl); setPhase('plan-ready'); addLog('Plan ready.'); } catch (e) { addLog(`Error: ${e.message}`); } setBusy(false); };
  const generate = async () => { setBusy(true); setPhase('generating'); addLog('Generating backend…'); try { const r = await api.generate(projectId, components); setFiles(r.files || []); setSelFile(r.files?.[0] || null); setPhase('generated'); addLog(r.summary || 'Generated.'); } catch (e) { addLog(`Error: ${e.message}`); } setBusy(false); };
  const deploy = async () => { setBusy(true); setPhase('deploying'); addLog('Deploying…'); try { const r = await api.deploy(projectId); setDeployResults(r); setPhase('deployed'); addLog(`Deploy done: ${r.filter((x) => x.status === 'deployed').length} live.`); } catch (e) { addLog(`Error: ${e.message}`); } setBusy(false); };
  const healthCheck = async () => { setBusy(true); try { setHealth(await api.health(projectId)); } catch (e) { addLog(`Error: ${e.message}`); } setBusy(false); };
  const wire = async () => { setBusy(true); try { const r = await api.wire(projectId); addLog(r.message || r.error); if (!r.error) { const f = await api.files(projectId); setFiles(f); } } catch (e) { addLog(`Error: ${e.message}`); } setBusy(false); };

  const readiness = components && catalog ? Object.entries(components).map(([type, id]) => { const comp = catalog.components.find((c) => c.type === type); const opt = comp?.options.find((o) => o.id === id); return { type, id, comp, opt }; }) : [];

  return (
    <div className="architect">
      <header>
        <span>◇ ARCHITECT</span>
        {onClose && <button onClick={onClose} title="Close">×</button>}
      </header>
      <div className="body">
        {!projectId && !initialId && (
          <div className="card">
            <div className="label">New project</div>
            <input placeholder="App name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
            <textarea placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
            <div className="label" style={{ marginTop: 8 }}>Frontend config (JSON)</div>
            <textarea value={frontendConfig} onChange={(e) => setFrontendConfig(e.target.value)} style={{ minHeight: 70 }} />
            <div className="label" style={{ marginTop: 8 }}>Connections (JSON — env keys/values)</div>
            <textarea value={connections} onChange={(e) => setConnections(e.target.value)} style={{ minHeight: 70 }} />
            <div style={{ marginTop: 8 }}><button className="btn" disabled={busy} onClick={create}>{busy ? <span className="spinner" /> : 'CREATE & PLAN'}</button></div>
            {projects.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="label">Or open existing</div>
                {projects.map((p) => (<button key={p.id} className="btn sec" style={{ marginRight: 6, marginBottom: 6 }} onClick={() => { setProjectId(p.id); setPhase('plan-ready'); }}>{p.name}</button>))}
              </div>
            )}
          </div>
        )}

        {projectId && catalog && components && (
          <>
            <div className="row">
              <span className="phase">{phase}</span>
              <button className="btn sec" onClick={() => { setProjectId(null); setPlan(null); setFiles([]); setDeployResults([]); }}>← BACK</button>
            </div>

            {plan && (
              <div className="card">
                <div className="label">// architecture plan</div>
                <div style={{ fontSize: 12 }}>{plan.summary}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                  {plan.database?.tables && `Tables: ${plan.database.tables.map((t) => t.name).join(', ')} · `}
                  {plan.api?.routes && `${plan.api.routes.length} routes · `}
                  Auth: {plan.auth?.strategy || 'none'}
                </div>
              </div>
            )}

            <div>
              <div className="label">// infrastructure — auto-suggested, change as needed</div>
              {readiness.map(({ type, id, comp, opt }) => (
                <div key={type} className="card" style={{ marginBottom: 6 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <strong style={{ fontSize: 12 }}>{comp?.label}</strong>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{opt?.freeTier}</div>
                    </div>
                    <select value={id} onChange={(e) => setComponents((p) => ({ ...p, [type]: e.target.value }))}>
                      {comp?.options.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
                    </select>
                  </div>
                </div>
              ))}
            </div>

            {files.length > 0 && (
              <div>
                <div className="label">// backend files ({files.length})</div>
                <div className="files">
                  <div className="tree">
                    {[...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => (
                      <button key={f.path} className={selFile?.path === f.path ? 'active' : ''} onClick={() => setSelFile(f)}>{f.path}</button>
                    ))}
                  </div>
                  <div className="view">{selFile ? selFile.content : 'Select a file'}</div>
                </div>
              </div>
            )}

            {deployResults.length > 0 && (
              <div>
                <div className="label">// deploy results</div>
                {deployResults.map((r, i) => (
                  <div key={i} className={`card ${r.status === 'deployed' ? 'ok' : r.status === 'error' ? 'err' : ''}`} style={{ marginBottom: 6 }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <strong style={{ fontSize: 12 }}>{r.component} — {r.label}</strong>
                      <span className={`tag ${r.status === 'deployed' ? 'live' : r.status === 'error' ? 'creds' : 'zip'}`}>{r.status}</span>
                    </div>
                    {r.message && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{r.message}</div>}
                    {r.url && <a href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>{r.url}</a>}
                    {r.zipUrl && <a href={r.zipUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>↓ download ZIP</a>}
                    {r.configMessage && <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 4 }}>{r.configMessage}</div>}
                  </div>
                ))}
              </div>
            )}

            {health && (
              <div className={`card ${health.healthy ? 'ok' : 'err'}`}>
                <div className="label">// health</div>
                <div style={{ fontSize: 12 }}>{health.healthy ? '● HEALTHY' : '○ UNHEALTHY'} {health.url} ({health.statusCode}, {health.responseTimeMs}ms)</div>
                {!health.healthy && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{health.error}</div>}
              </div>
            )}

            {log.length > 0 && (
              <div className="log">{log.map((l, i) => (<div key={i}>{l}</div>))}</div>
            )}
          </>
        )}
      </div>

      {projectId && (
        <footer style={{ borderTop: '1px solid var(--border)', padding: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {phase === 'plan-ready' && <button className="btn" disabled={busy} onClick={runPlan}>{busy ? <span className="spinner" /> : 'PLAN'}</button>}
          {phase === 'plan-ready' && plan && <button className="btn" disabled={busy} onClick={generate}>GENERATE</button>}
          {phase === 'generated' && <button className="btn" disabled={busy} onClick={deploy}>{busy ? <span className="spinner" /> : 'DEPLOY'}</button>}
          {phase === 'generated' && <button className="btn sec" disabled={busy} onClick={() => setPhase('plan-ready')}>REGENERATE</button>}
          {phase === 'deployed' && <button className="btn sec" disabled={busy} onClick={healthCheck}>CHECK HEALTH</button>}
          {phase === 'deployed' && <button className="btn sec" disabled={busy} onClick={wire}>WIRE FRONTEND</button>}
          {phase === 'deployed' && <button className="btn sec" disabled={busy} onClick={deploy}>REDEPLOY</button>}
        </footer>
      )}
    </div>
  );
}