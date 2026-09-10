import { useState, useEffect, useCallback } from 'react';
import { Loader2, Folder, FileCode, ChevronLeft, Check, Trash2, Download, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// CODE tab of the WEBSITE panel — browse the connected repo and pull the
// files you actually work with (a theme folder, a few templates) into the
// project so chat builds can see and edit them. A full WP install is huge;
// you import the handful you touch, not the lot.

function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function CodeTab({ projectId }) {
  const [dir, setDir] = useState('');
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [imported, setImported] = useState(null);

  const loadTree = useCallback(async (d) => {
    setLoading(true); setErr(null);
    try {
      const { data } = await base44.functions.invoke('repoFiles', { projectId, action: 'tree', dir: d });
      setTree(data);
      setDir(data.dir || '');
    } catch (e) {
      const msg = e?.data?.error || e.message;
      setErr(msg);
      if (e?.data?.status === 400 || /repo|connect/i.test(msg)) setTree({ notReady: true, reason: msg });
    } finally { setLoading(false); }
  }, [projectId]);

  const loadImported = useCallback(async () => {
    try {
      const { data } = await base44.functions.invoke('repoFiles', { projectId, action: 'imported' });
      setImported(data);
    } catch { /* non-fatal */ }
  }, [projectId]);

  useEffect(() => { loadTree(''); loadImported(); }, [loadTree, loadImported]);

  const toggle = (path) => setSelected((s) => {
    const n = new Set(s);
    n.has(path) ? n.delete(path) : n.add(path);
    return n;
  });

  const runImport = async () => {
    if (!selected.size) return;
    setImporting(true); setErr(null); setResult(null);
    try {
      const { data } = await base44.functions.invoke('repoFiles', { projectId, action: 'import', paths: [...selected] });
      setResult(data);
      setSelected(new Set());
      loadImported();
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setImporting(false); }
  };

  const removeFile = async (path) => {
    try {
      await base44.functions.invoke('repoFiles', { projectId, action: 'remove', paths: [path] });
      loadImported();
    } catch (e) { setErr(e?.data?.error || e.message); }
  };

  if (tree?.notReady) {
    return (
      <div className="p-4 text-[12px] text-primary/55 leading-relaxed">
        {tree.reason}
        <div className="text-[10px] text-primary/40 mt-2">Set the repo in Settings → Morpheus on your site, then reopen this tab.</div>
      </div>
    );
  }

  const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';

  return (
    <div className="p-4 space-y-4">
      <p className="text-[11px] text-primary/50 leading-relaxed">
        Pull the files chat should be able to edit — your theme folder, key templates, the stylesheet. Keep it tight; WordPress core is skipped automatically.
      </p>

      {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}

      {/* breadcrumb */}
      <div className="flex items-center gap-2 text-[11px]">
        {dir ? (
          <button onClick={() => loadTree(parent)} className="flex items-center gap-1 text-primary/60 hover:text-primary">
            <ChevronLeft size={13} /> up
          </button>
        ) : <span className="text-primary/40">{tree?.repo} · {tree?.branch}</span>}
        {dir && <span className="text-primary/50 font-mono truncate">/{dir}</span>}
        <button onClick={() => loadTree(dir)} className="ml-auto text-primary/40 hover:text-primary"><RefreshCw size={11} /></button>
      </div>

      {loading && <div className="flex items-center gap-2 text-primary/60 text-xs"><Loader2 size={13} className="animate-spin" /> Loading…</div>}

      {!loading && tree && !tree.notReady && (
        <div className="border border-primary/15 max-h-[46vh] overflow-y-auto scrollbar-matrix divide-y divide-primary/10">
          {tree.dirs.map((d) => (
            <div key={d.path} className={`flex items-center gap-2 px-2.5 py-2 ${d.skippable ? 'opacity-40' : ''}`}>
              <input type="checkbox" checked={selected.has(d.path)} onChange={() => toggle(d.path)} disabled={d.skippable}
                className="accent-[color:var(--primary,#4f8cff)] w-3.5 h-3.5 shrink-0" />
              <button onClick={() => !d.skippable && loadTree(d.path)} disabled={d.skippable}
                className="flex items-center gap-1.5 text-[12px] text-primary/80 hover:text-primary min-w-0">
                <Folder size={13} className="shrink-0" /> <span className="truncate">{d.name}/</span>
              </button>
            </div>
          ))}
          {tree.files.map((f) => (
            <label key={f.path} className={`flex items-center gap-2 px-2.5 py-2 ${f.skippable || f.denied ? 'opacity-40' : 'cursor-pointer'}`}>
              <input type="checkbox" checked={selected.has(f.path)} onChange={() => toggle(f.path)} disabled={f.skippable || f.denied}
                className="accent-[color:var(--primary,#4f8cff)] w-3.5 h-3.5 shrink-0" />
              <FileCode size={13} className="text-primary/50 shrink-0" />
              <span className="text-[12px] text-primary/75 truncate flex-1">{f.name}</span>
              <span className="text-[9px] text-primary/35 shrink-0">{f.denied ? 'protected' : fmtBytes(f.size)}</span>
            </label>
          ))}
          {tree.dirs.length === 0 && tree.files.length === 0 && (
            <div className="px-2.5 py-3 text-[11px] text-primary/40">Empty.</div>
          )}
        </div>
      )}

      <button onClick={runImport} disabled={!selected.size || importing}
        className="w-full flex items-center justify-center gap-2 h-[44px] bg-primary text-black font-bold text-[12px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors">
        {importing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {importing ? 'IMPORTING…' : `IMPORT SELECTED${selected.size ? ` (${selected.size})` : ''}`}
      </button>

      {result && (
        <div className="text-[11px] text-primary/70 border border-primary/25 px-3 py-2 leading-relaxed">
          {result.imported} imported{result.updated ? `, ${result.updated} refreshed` : ''}{result.failed ? `, ${result.failed} failed` : ''}. Project has {result.total}/{result.cap} files.
          {result.note && <div className="text-primary/45 mt-1">{result.note}</div>}
        </div>
      )}

      {/* what's in the project */}
      {imported && (imported.files.length > 0 || imported.otherCount > 0) && (
        <div className="border-t border-primary/15 pt-3 space-y-1.5">
          <div className="text-[10px] text-primary/40 uppercase tracking-wider">
            In this project — {imported.files.length} from the repo{imported.otherCount ? ` · ${imported.otherCount} other` : ''}
          </div>
          {imported.files.map((f) => (
            <div key={f.path} className="flex items-center gap-2 text-[10px]">
              <Check size={11} className="text-primary/50 shrink-0" />
              <span className="text-primary/65 font-mono truncate flex-1">{f.path}</span>
              <button onClick={() => removeFile(f.path)} className="text-primary/30 hover:text-red-400 shrink-0"><Trash2 size={11} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="text-[10px] text-primary/35 leading-relaxed">
        Once files are in, chat in this project — Morpheus edits them the WordPress way, and ships through the Deploy tab. It never touches WP core or plugins it didn’t write.
      </div>
    </div>
  );
}
