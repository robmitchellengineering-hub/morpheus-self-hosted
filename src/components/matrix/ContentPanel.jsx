import { useState, useEffect, useCallback } from 'react';
import { X, FileJson, Loader2, Check, Plus, Trash2, ChevronLeft } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Light CMS (2026-09-09). Reads content/*.json straight from the connected
// repo, renders an editor for the values, commits the change back — the host
// redeploys on the push. Morpheus stores none of it. See lib/projectCms.js.

function blankLike(v) {
  if (Array.isArray(v)) return v.length ? [blankLike(v[0])] : [];
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = blankLike(v[k]); return o; }
  if (typeof v === 'number') return 0;
  if (typeof v === 'boolean') return false;
  return '';
}

function setIn(obj, path, value) {
  if (!path.length) return value;
  const [head, ...rest] = path;
  const clone = Array.isArray(obj) ? obj.slice() : { ...obj };
  clone[head] = setIn(obj[head], rest, value);
  return clone;
}

function Label({ children }) {
  return <div className="text-[10px] text-primary/45 uppercase tracking-wider mb-0.5">{children}</div>;
}

function JsonNode({ value, path, onChange, keyName }) {
  const set = (v) => onChange(path, v);

  if (Array.isArray(value)) {
    return (
      <div className="space-y-2">
        {keyName != null && <Label>{keyName} · {value.length}</Label>}
        {value.map((item, i) => (
          <div key={i} className="border border-primary/15 p-2 relative">
            <button
              onClick={() => set(value.filter((_, j) => j !== i))}
              className="absolute top-1 right-1 text-primary/30 hover:text-red-400"
              title="Remove"
            ><Trash2 size={11} /></button>
            <JsonNode value={item} path={[...path, i]} onChange={onChange} />
          </div>
        ))}
        <button
          onClick={() => set([...value, value.length ? blankLike(value[value.length - 1]) : ''])}
          className="flex items-center gap-1 text-[10px] text-primary/55 hover:text-primary border border-primary/20 hover:border-primary/50 px-2 py-1"
        ><Plus size={10} /> ADD {keyName ? keyName.replace(/s$/, '').toUpperCase() : 'ITEM'}</button>
      </div>
    );
  }

  if (value && typeof value === 'object') {
    return (
      <div className="space-y-2.5">
        {keyName != null && <Label>{keyName}</Label>}
        <div className={keyName != null ? 'pl-2 border-l border-primary/15 space-y-2.5' : 'space-y-2.5'}>
          {Object.keys(value).map((k) => (
            <JsonNode key={k} value={value[k]} path={[...path, k]} onChange={onChange} keyName={k} />
          ))}
        </div>
      </div>
    );
  }

  // primitive
  const isLong = typeof value === 'string' && (value.length > 60 || value.includes('\n'));
  return (
    <label className="block">
      {keyName != null && <Label>{keyName}</Label>}
      {typeof value === 'boolean' ? (
        <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} className="accent-[color:var(--primary,#4f8cff)] w-4 h-4" />
      ) : typeof value === 'number' ? (
        <input type="number" value={value} onChange={(e) => set(e.target.value === '' ? 0 : Number(e.target.value))}
          className="w-full bg-black/30 border border-primary/20 px-2 py-1 text-[11px] text-primary font-mono focus:outline-none focus:border-primary/50" />
      ) : isLong ? (
        <textarea value={value ?? ''} onChange={(e) => set(e.target.value)} rows={Math.min(8, (String(value).match(/\n/g) || []).length + 2)}
          className="w-full bg-black/30 border border-primary/20 px-2 py-1 text-[11px] text-primary focus:outline-none focus:border-primary/50" />
      ) : (
        <input value={value ?? ''} onChange={(e) => set(e.target.value)}
          className="w-full bg-black/30 border border-primary/20 px-2 py-1 text-[11px] text-primary focus:outline-none focus:border-primary/50" />
      )}
    </label>
  );
}

export default function ContentPanel({ open, onClose, projectId }) {
  const [state, setState] = useState(null); // { connected, files, repo, branch }
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(null); // path
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setErr(null);
    try {
      const { data } = await base44.functions.invoke('getProjectContent', { projectId });
      setState(data);
    } catch (e) {
      setErr(e?.data?.error || e.message);
    }
  }, [projectId]);

  useEffect(() => { if (open) { setSelected(null); setDraft(null); setSavedPath(null); load(); } }, [open, load]);

  if (!open) return null;

  const files = state?.files || [];
  const current = files.find((f) => f.path === selected);

  const openFile = (f) => {
    if (f.parseError) return;
    setSelected(f.path);
    setDraft(JSON.parse(JSON.stringify(f.json)));
    setSavedPath(null);
  };

  const onChange = (path, value) => { setDraft((d) => setIn(d, path, value)); setSavedPath(null); };

  const save = async () => {
    if (!current) return;
    setSaving(true); setErr(null);
    try {
      const { data } = await base44.functions.invoke('saveProjectContent', { projectId, path: current.path, json: draft, sha: current.sha });
      setSavedPath(current.path);
      // refresh shas so a second save in the same session works
      setState((s) => ({ ...s, files: s.files.map((f) => f.path === data.path ? { ...f, sha: data.sha, json: JSON.parse(JSON.stringify(draft)) } : f) }));
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = current && JSON.stringify(draft) !== JSON.stringify(current.json);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div className="bg-background border-l border-primary/40 w-full max-w-md h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            {selected && <button onClick={() => { setSelected(null); setDraft(null); }} className="text-primary/60 hover:text-primary"><ChevronLeft size={16} /></button>}
            <FileJson size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">{current ? current.name.toUpperCase() : 'CONTENT'}</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <p className="text-[11px] text-ink/45 leading-relaxed px-4 py-2 border-b border-primary/10">
          Text and lists the builder put in <span className="font-mono">content/*.json</span>. Edits commit straight to your repo and your host redeploys — no rebuild, nothing stored here.
        </p>

        {err && <div className="m-4 text-red-400 text-xs border border-red-500/30 px-3 py-2">{err}</div>}
        {!state && !err && <div className="p-4 flex items-center gap-2 text-ink/60 text-xs"><Loader2 size={14} className="animate-spin" /> Loading…</div>}

        {state && !state.connected && (
          <div className="p-4 text-[11px] text-ink/50 leading-relaxed">
            Connect this project to a GitHub repo (Export to GitHub) to edit its content here.
          </div>
        )}

        {state?.connected && !selected && (
          <div className="flex-1 overflow-y-auto scrollbar-matrix p-3">
            <div className="text-[10px] text-ink/40 mb-2">{state.repo} · {state.branch}</div>
            {files.length === 0 && (
              <div className="text-[11px] text-ink/50 leading-relaxed">
                No <span className="font-mono">content/*.json</span> files yet. Ask Morpheus in chat to “move the site text into content files” and they’ll show up here.
              </div>
            )}
            <div className="space-y-1.5">
              {files.map((f) => (
                <button key={f.path} onClick={() => openFile(f)} disabled={!!f.parseError}
                  className={`w-full text-left border px-3 py-2 transition-colors ${f.parseError ? 'border-red-500/30 opacity-60' : 'border-primary/15 hover:border-primary/40'}`}>
                  <div className="text-[12px] text-ink/85 capitalize">{f.name}</div>
                  <div className="text-[9px] text-ink/35 font-mono">{f.path}{f.parseError ? ` · invalid JSON: ${f.parseError}` : ''}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {state?.connected && current && draft != null && (
          <>
            <div className="flex-1 overflow-y-auto scrollbar-matrix p-4">
              <JsonNode value={draft} path={[]} onChange={onChange} />
            </div>
            <div className="p-3 border-t border-primary/20 shrink-0 flex items-center gap-2">
              <button onClick={save} disabled={saving || !dirty}
                className="flex items-center gap-1.5 px-4 py-1.5 border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-[11px] disabled:opacity-40">
                {saving ? <Loader2 size={12} className="animate-spin" /> : savedPath === current.path && !dirty ? <Check size={12} /> : <FileJson size={12} />}
                {savedPath === current.path && !dirty ? 'COMMITTED' : 'SAVE & PUBLISH'}
              </button>
              <span className="text-[10px] text-ink/40">{dirty ? 'Commits to ' + current.path : 'Your host redeploys on save.'}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
