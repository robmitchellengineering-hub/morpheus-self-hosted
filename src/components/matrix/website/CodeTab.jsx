import { useState, useEffect, useCallback } from 'react';
import { Loader2, Folder, FileCode, ChevronLeft, Check, Trash2, Download, RefreshCw, GitBranch, KeyRound } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const inputSm = 'w-full bg-black/30 border border-primary/20 px-2.5 h-[36px] text-[12px] text-primary focus:outline-none focus:border-primary/50';

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

  const [config, setConfig] = useState(null); // { repo, repoSource, branch, tokenScope }
  const [repoInput, setRepoInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgMsg, setCfgMsg] = useState(null);

  const loadConfig = useCallback(async () => {
    try {
      const { data } = await base44.functions.invoke('repoFiles', { projectId, action: 'config' });
      setConfig(data);
      setRepoInput(data.repo || '');
    } catch (e) { setErr(e?.data?.error || e.message); }
  }, [projectId]);

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

  useEffect(() => { loadConfig(); loadTree(''); loadImported(); }, [loadConfig, loadTree, loadImported]);

  const saveConfig = async ({ token, clearToken } = {}) => {
    setSavingCfg(true); setErr(null); setCfgMsg(null);
    try {
      const { data } = await base44.functions.invoke('setProjectGithub', {
        projectId,
        repo: repoInput.trim() !== (config?.repo || '') ? repoInput.trim() : undefined,
        token: token || undefined,
        clearToken: clearToken || undefined,
      });
      setTokenInput('');
      setCfgMsg(data.canPush === false
        ? 'Connected (read-only — this token/account can’t push, so deploys will fail).'
        : 'Saved.');
      await loadConfig();
      loadTree('');
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setSavingCfg(false); }
  };

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

  const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  const repoLocked = config?.repoSource === 'plugin'; // set on the plugin side (Settings → Morpheus)
  const noRepo = tree?.notReady || !config?.repo;

  return (
    <div className="p-4 space-y-4">
      {/* repo & access */}
      <div className="border border-primary/20 p-3 space-y-2.5">
        <div className="flex items-center gap-1.5 text-[10px] text-primary/40 uppercase tracking-wider"><GitBranch size={11} /> Repo &amp; access</div>
        {repoLocked ? (
          <div className="text-[11px] text-ink/70 font-mono break-all">{config.repo} · {config.branch}
            <div className="text-[9px] text-ink/35 font-sans normal-case tracking-normal mt-0.5">Set on the site (Settings → Morpheus) — change it there.</div>
          </div>
        ) : (
          <div className="flex gap-2">
            <input className={inputSm} placeholder="owner/repo" value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)} autoCapitalize="off" autoCorrect="off" />
            <button onClick={() => saveConfig()} disabled={savingCfg || repoInput.trim() === (config?.repo || '')}
              className="shrink-0 px-3 h-[36px] text-[11px] border border-primary/40 text-primary/80 hover:border-primary hover:text-primary disabled:opacity-40">
              {savingCfg ? <Loader2 size={11} className="animate-spin" /> : 'Save'}
            </button>
          </div>
        )}

        <div className="flex items-center gap-1.5 text-[10px] text-ink/45">
          <KeyRound size={10} />
          {config?.tokenScope === 'construct'
            ? <span>Using a token set for this construct.</span>
            : <span>Using your global GitHub connection.</span>}
          {config?.tokenScope === 'construct' && (
            <button onClick={() => saveConfig({ clearToken: true })} disabled={savingCfg} className="text-primary/40 hover:text-red-400 ml-auto">clear</button>
          )}
        </div>
        <div className="flex gap-2">
          <input className={inputSm} type="password" placeholder="paste a token for this repo (optional)"
            value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} autoCapitalize="off" autoCorrect="off" />
          <button onClick={() => saveConfig({ token: tokenInput.trim() })} disabled={savingCfg || tokenInput.trim().length < 8}
            className="shrink-0 px-3 h-[36px] text-[11px] border border-primary/40 text-primary/80 hover:border-primary hover:text-primary disabled:opacity-40">
            Set
          </button>
        </div>
        <div className="text-[9px] text-ink/35 leading-relaxed">
          For a client repo your own GitHub account can’t reach: paste a fine-grained token scoped to just that repo (Contents: read &amp; write). Stored encrypted.
        </div>
        {cfgMsg && <div className="text-[10px] text-ink/60">{cfgMsg}</div>}
      </div>

      {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}

      {noRepo ? (
        <div className="text-[11px] text-ink/45 leading-relaxed">
          {tree?.notReady ? tree.reason : 'Connect a repo above to browse and import its files.'}
        </div>
      ) : (
      <>
      <p className="text-[11px] text-ink/50 leading-relaxed">
        Pull the files chat should be able to edit — your theme folder, key templates, the stylesheet. Keep it tight; WordPress core is skipped automatically.
      </p>

      {/* breadcrumb */}
      <div className="flex items-center gap-2 text-[11px]">
        {dir ? (
          <button onClick={() => loadTree(parent)} className="flex items-center gap-1 text-primary/60 hover:text-primary">
            <ChevronLeft size={13} /> up
          </button>
        ) : <span className="text-ink/40">{tree?.repo} · {tree?.branch}</span>}
        {dir && <span className="text-ink/50 font-mono truncate">/{dir}</span>}
        <button onClick={() => loadTree(dir)} className="ml-auto text-primary/40 hover:text-primary"><RefreshCw size={11} /></button>
      </div>

      {loading && <div className="flex items-center gap-2 text-ink/60 text-xs"><Loader2 size={13} className="animate-spin" /> Loading…</div>}

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
              <span className="text-[12px] text-ink/75 truncate flex-1">{f.name}</span>
              <span className="text-[9px] text-ink/35 shrink-0">{f.denied ? 'protected' : fmtBytes(f.size)}</span>
            </label>
          ))}
          {tree.dirs.length === 0 && tree.files.length === 0 && (
            <div className="px-2.5 py-3 text-[11px] text-ink/40">Empty.</div>
          )}
        </div>
      )}

      <button onClick={runImport} disabled={!selected.size || importing}
        className="w-full flex items-center justify-center gap-2 h-[44px] bg-primary text-black font-bold text-[12px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors">
        {importing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {importing ? 'IMPORTING…' : `IMPORT SELECTED${selected.size ? ` (${selected.size})` : ''}`}
      </button>

      {result && (
        <div className="text-[11px] text-ink/70 border border-primary/25 px-3 py-2 leading-relaxed">
          {result.imported} imported{result.updated ? `, ${result.updated} refreshed` : ''}{result.failed ? `, ${result.failed} failed` : ''}. Project has {result.total}/{result.cap} files.
          {result.note && <div className="text-ink/45 mt-1">{result.note}</div>}
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
              <span className="text-ink/65 font-mono truncate flex-1">{f.path}</span>
              <button onClick={() => removeFile(f.path)} className="text-primary/30 hover:text-red-400 shrink-0"><Trash2 size={11} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="text-[10px] text-ink/35 leading-relaxed">
        Once files are in, chat in this project — Morpheus edits them the WordPress way, and ships through the Deploy tab. It never touches WP core or plugins it didn’t write.
      </div>
      </>
      )}
    </div>
  );
}
