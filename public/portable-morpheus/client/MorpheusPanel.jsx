import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from './api.js';

// Self-contained, themeable Morpheus chat + file panel. No external UI deps.
// Mount it with a projectId, or leave null to show the project picker.
// Matrix-themed: black background, neon green text, terminal feel.

const CSS = `
.morpheus{--bg:#000;--fg:#00ff41;--muted:#4a8a5a;--dim:#2a5a35;--border:#1a3a22;--danger:#ff4d4d;--warn:#ffcc00;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);background:var(--bg);
  border:1px solid var(--border);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;max-height:90vh;min-height:420px}
.morpheus *{box-sizing:border-box}
.morpheus header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);font-weight:700;letter-spacing:.08em}
.morpheus header .title{text-shadow:0 0 6px var(--fg)}
.morpheus header button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px}
.morpheus .body{padding:0;overflow-y:auto;flex:1;display:flex;flex-direction:column}
.morpheus .msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.morpheus .msg{max-width:88%;padding:8px 12px;border-radius:6px;font-size:13px;line-height:1.5;white-space:pre-wrap;border:1px solid var(--border)}
.morpheus .msg.user{align-self:flex-end;background:rgba(0,255,65,.06);border-color:var(--dim)}
.morpheus .msg.morp{align-self:flex-start;background:#050a05}
.morpheus .msg .who{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:.1em;margin-bottom:3px}
.morpheus .files{border-top:1px solid var(--border);padding:10px 14px;max-height:200px;overflow-y:auto}
.morpheus .files .label{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:.08em;margin-bottom:6px}
.morpheus .files .grid{display:flex;gap:8px}
.morpheus .files .tree{width:40%;border:1px solid var(--border);border-radius:4px;max-height:150px;overflow-y:auto}
.morpheus .files .tree button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--muted);padding:4px 8px;font:inherit;font-size:11px;cursor:pointer}
.morpheus .files .tree button.active{background:rgba(0,255,65,.1);color:var(--fg)}
.morpheus .files .view{flex:1;border:1px solid var(--border);border-radius:4px;padding:8px;font-size:11px;white-space:pre-wrap;overflow-y:auto;max-height:150px;color:var(--muted)}
.morpheus .picker{padding:16px;display:flex;flex-direction:column;gap:10px}
.morpheus .picker .card{border:1px solid var(--border);border-radius:6px;padding:12px}
.morpheus input,.morpheus select,.morpheus textarea{background:#000;color:var(--fg);border:1px solid var(--border);
  border-radius:4px;padding:7px 9px;font:inherit;font-size:12px;outline:none;width:100%}
.morpheus input:focus,.morpheus select:focus,.morpheus textarea:focus{border-color:var(--fg)}
.morpheus textarea{min-height:64px;resize:vertical}
.morpheus .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.morpheus button.btn{background:#000;color:var(--fg);border:1px solid var(--fg);border-radius:4px;padding:8px 16px;
  font:inherit;font-weight:700;font-size:12px;cursor:pointer;letter-spacing:.05em}
.morpheus button.btn:hover{background:var(--fg);color:#000}
.morpheus button.btn.sec{border-color:var(--border)}
.morpheus button.btn.sec:hover{border-color:var(--fg);background:transparent;color:var(--fg)}
.morpheus button.btn:disabled{opacity:.4;cursor:not-allowed}
.morpheus .label{font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:.08em;margin-bottom:6px}
.morpheus .tag{font-size:10px;border:1px solid var(--border);padding:1px 5px;border-radius:3px;text-transform:uppercase}
.morpheus .composer{border-top:1px solid var(--border);padding:10px 14px;display:flex;gap:8px;align-items:flex-end}
.morpheus .composer textarea{min-height:40px;max-height:120px;flex:1}
.morpheus .phase{font-size:11px;color:var(--muted);text-transform:capitalize}
.morpheus .spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--fg);border-radius:50%;animation:mspin .7s linear infinite}
@keyframes mspin{to{transform:rotate(360deg)}}
.morpheus a{color:var(--fg)}
.morpheus .empty{padding:24px;text-align:center;color:var(--muted);font-size:12px}
.morpheus .ops{font-size:10px;color:var(--muted);margin-top:4px}
`;

const COMPILE_TARGETS = ['source', 'windows-exe', 'mac-app', 'linux-binary', 'android-apk', 'ios-app', 'python-package', 'web-app', 'rpi-distro', 'arduino-firmware'];

export default function MorpheusPanel({ projectId: initialId, onClose }) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(initialId || null);
  const [project, setProject] = useState(null);
  const [messages, setMessages] = useState([]);
  const [files, setFiles] = useState([]);
  const [selFile, setSelFile] = useState(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [target, setTarget] = useState('source');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);
  const msgsRef = useRef(null);

  useEffect(() => { if (!document.getElementById('morpheus-css')) { const s = document.createElement('style'); s.id = 'morpheus-css'; s.textContent = CSS; document.head.appendChild(s); } }, []);
  useEffect(() => { if (!initialId) api.listProjects().then(setProjects).catch(() => {}); }, [initialId]);

  const load = useCallback(async (id) => {
    if (!id) return;
    try {
      const data = await api.getProject(id);
      if (data.error) { setError(data.error); return; }
      setProject(data.project);
      setMessages(data.messages || []);
      setFiles(data.files || []);
      setSelFile(data.files?.[0] || null);
      setPhase(data.project?.status || 'idle');
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { if (projectId) load(projectId); }, [projectId, load]);
  useEffect(() => { if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight; }, [messages, busy]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const p = await api.createProject({ name: name || 'Untitled', description: desc, compileTarget: target });
      setProjectId(p.id);
      setProject(p); setMessages([]); setFiles([]); setSelFile(null); setPhase('init');
      api.listProjects().then(setProjects).catch(() => {});
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const send = async () => {
    if (!input.trim() || !projectId) return;
    const text = input.trim();
    setMessages((m) => [...m, { role: 'user', content: text, date: new Date().toISOString() }]);
    setInput(''); setBusy(true); setError(null); setPhase('building');
    try {
      const res = await api.chat(projectId, text);
      setMessages((m) => [...m, { role: 'morpheus', content: res.reply, date: new Date().toISOString() }]);
      if (res.fileOperations && res.fileOperations.length > 0) {
        const f = await api.files(projectId);
        setFiles(f); setSelFile(f[0] || null);
        setProject((p) => p ? { ...p, status: 'building' } : p);
      }
      setPhase(res.needsClarification ? 'clarify' : 'ready');
    } catch (e) { setError(e.message); setPhase('ready'); }
    setBusy(false);
  };

  const del = async (id) => {
    if (!confirm('Delete this project permanently?')) return;
    try { await api.deleteProject(id); if (id === projectId) { setProjectId(null); setProject(null); setMessages([]); setFiles([]); } api.listProjects().then(setProjects).catch(() => {}); } catch (e) { setError(e.message); }
  };

  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

  return (
    <div className="morpheus">
      <header>
        <span className="title">◇ MORPHEUS</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {project && <span className="tag">{project.compileTarget}</span>}
          {project && <a href={api.zipUrl(projectId)} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>↓ ZIP</a>}
          {projectId && <button className="btn sec" style={{ padding: '4px 10px' }} onClick={() => { setProjectId(null); setProject(null); setMessages([]); setFiles([]); }}>←</button>}
          {onClose && <button onClick={onClose} title="Close">×</button>}
        </span>
      </header>

      <div className="body">
        {!projectId && !initialId && (
          <div className="picker">
            <div className="card">
              <div className="label">New construct</div>
              <input placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 8 }} />
              <textarea placeholder="What do you want to build?" value={desc} onChange={(e) => setDesc(e.target.value)} />
              <div className="label" style={{ marginTop: 8 }}>Compile target</div>
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {COMPILE_TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <div style={{ marginTop: 10 }}><button className="btn" disabled={busy} onClick={create}>{busy ? <span className="spinner" /> : 'CREATE'}</button></div>
            </div>
            {projects.length > 0 && (
              <div className="card">
                <div className="label">Open existing</div>
                {projects.map((p) => (
                  <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                    <button className="btn sec" style={{ padding: '4px 10px' }} onClick={() => setProjectId(p.id)}>{p.name}</button>
                    <button onClick={() => del(p.id)} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 11 }}>delete</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {projectId && (
          <>
            <div className="msgs" ref={msgsRef}>
              {messages.length === 0 && !busy && (
                <div className="empty">{`> Morpheus is here.\n> Tell me what you want to build. I can only show you the door.`}</div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`msg ${m.role === 'user' ? 'user' : 'morp'}`}>
                  <div className="who">{m.role === 'user' ? 'OPERATOR' : 'MORPHEUS'}</div>
                  {m.content}
                </div>
              ))}
              {busy && <div className="msg morp"><span className="spinner" /> <span style={{ color: 'var(--muted)', marginLeft: 6 }}>{phase === 'building' ? 'building…' : 'thinking…'}</span></div>}
              {error && <div className="msg morp" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{error}</div>}
            </div>

            {files.length > 0 && (
              <div className="files">
                <div className="label">// files ({files.length})</div>
                <div className="grid">
                  <div className="tree">
                    {sortedFiles.map((f) => (
                      <button key={f.path} className={selFile?.path === f.path ? 'active' : ''} onClick={() => setSelFile(f)}>{f.path}</button>
                    ))}
                  </div>
                  <div className="view">{selFile ? selFile.content : 'Select a file'}</div>
                </div>
              </div>
            )}

            <div className="composer">
              <textarea placeholder="> speak…" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} disabled={busy} />
              <button className="btn" disabled={busy || !input.trim()} onClick={send}>{busy ? <span className="spinner" /> : 'SEND'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}