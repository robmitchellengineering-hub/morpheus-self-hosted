import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Image as ImageIcon, Link2, Upload, Loader2, Trash2, Copy, Check, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';

// Media Library (2026-09-09) — a project's content assets. ZERO CUSTODY:
// Morpheus stores only the url + caption. "Add from device" commits the file
// straight into the user's own connected GitHub repo (public/assets/*).
// The builder is handed the asset list by name so it writes real <img src>.

const MAX_BYTES = 30 * 1024 * 1024;

function readImageDims(file) {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) return resolve({});
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve({}); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

function AssetCard({ asset, onDelete }) {
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isImg = asset.kind === 'image';
  const thumb = asset.preview_url || asset.url;
  const copy = () => {
    try { navigator.clipboard.writeText(asset.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
  };
  return (
    <div className="border border-primary/20 bg-primary/5 flex flex-col">
      <div className="h-28 bg-black/40 flex items-center justify-center overflow-hidden shrink-0">
        {isImg && thumb
          ? <img src={thumb} alt={asset.alt || asset.name} className="max-h-full max-w-full object-contain" loading="lazy" />
          : <span className="text-[10px] uppercase tracking-widest text-primary/40">{asset.kind}</span>}
      </div>
      <div className="p-2 flex flex-col gap-1 min-w-0">
        <div className="text-[11px] text-ink-max truncate" title={asset.name}>{asset.name}</div>
        <button onClick={copy} title="Copy the url the builder will use" className="flex items-center gap-1 text-[10px] text-primary/50 hover:text-primary font-mono truncate">
          {copied ? <Check size={10} className="shrink-0 text-primary" /> : <Copy size={10} className="shrink-0" />}
          <span className="truncate">{asset.url}</span>
        </button>
        <div className="flex items-center justify-between text-[10px] text-ink-max">
          <span>{asset.source === 'repo' ? 'in your repo' : 'your link'}{asset.width ? ` · ${asset.width}×${asset.height}` : ''}</span>
          <button onClick={async () => { setDeleting(true); try { await onDelete(asset.id); } finally { setDeleting(false); } }} className="text-primary/40 hover:text-red-400">
            {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MediaPanel({ open, onClose, projectId, onCountChange }) {
  const [state, setState] = useState(null); // { migrated, assets, githubRepo } | { error }
  const [tab, setTab] = useState('url'); // url | device
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [urlForm, setUrlForm] = useState({ url: '', name: '', alt: '' });
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await base44.functions.listProjectAssets(projectId);
      setState(data);
      onCountChange?.(data.assets?.length || 0);
    } catch (e) {
      setState({ error: e?.data?.error || e.message });
    }
  }, [projectId, onCountChange]);

  useEffect(() => { if (open) load(); }, [open, load]);

  if (!open) return null;

  const addUrl = async () => {
    if (!urlForm.url.trim()) return;
    setBusy(true); setErr(null);
    try {
      await base44.functions.addProjectAssetUrl(projectId, urlForm);
      setUrlForm({ url: '', name: '', alt: '' });
      await load();
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const addFile = async (file) => {
    if (!file) return;
    if (file.size > MAX_BYTES) { setErr('Over 30 MB — large media belongs on your own CDN. Paste its URL instead.'); return; }
    setBusy(true); setErr(null);
    try {
      const dims = await readImageDims(file);
      const form = new FormData();
      form.append('file', file);
      form.append('name', file.name.replace(/\.[a-z0-9]+$/i, ''));
      if (dims.width) { form.append('width', dims.width); form.append('height', dims.height); }
      await base44.functions.addProjectAssetFile(projectId, form);
      await load();
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setBusy(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const del = async (assetId) => {
    await base44.functions.deleteProjectAsset(projectId, assetId);
    await load();
  };

  const assets = state?.assets || [];
  const repo = state?.githubRepo;
  const hasRepo = !!repo && repo.includes('/');

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div className="bg-background border-l border-primary/40 w-full max-w-lg h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <ImageIcon size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">MEDIA LIBRARY</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <p className="text-[11px] text-ink-max leading-relaxed px-4 py-2 border-b border-primary/10">
          Content for the site — photos, posters, ads. Morpheus stores only the link, never the file.
          Listed assets are offered to the builder by name, so you can say “put the spring poster in the hero”.
        </p>

        {state?.migrated === false && (
          <div className="m-4 border border-yellow-500/40 bg-yellow-500/10 text-yellow-500/90 text-[11px] p-3 leading-relaxed">
            The <span className="font-mono">project_assets</span> table isn't created yet — run{' '}
            <span className="font-mono">server/prisma/add-project-assets-table.sql</span> against the database.
          </div>
        )}
        {state?.error && <div className="m-4 text-red-400 text-xs border border-red-500/30 px-3 py-2">{state.error}</div>}

        {state?.migrated !== false && !state?.error && (
          <>
            <div className="flex border-b border-primary/20 shrink-0">
              <button onClick={() => setTab('url')} className={`flex items-center gap-1.5 px-4 py-2.5 text-[11px] tracking-wider ${tab === 'url' ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-primary/60 hover:text-primary'}`}>
                <Link2 size={13} /> ADD A LINK
              </button>
              <button onClick={() => setTab('device')} className={`flex items-center gap-1.5 px-4 py-2.5 text-[11px] tracking-wider ${tab === 'device' ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-primary/60 hover:text-primary'}`}>
                <Upload size={13} /> FROM DEVICE
              </button>
            </div>

            <div className="p-3 border-b border-primary/10 shrink-0 space-y-2">
              {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-2 py-1.5 flex items-start gap-1.5"><AlertTriangle size={11} className="shrink-0 mt-0.5" /><span>{err}</span></div>}
              {tab === 'url' && (
                <>
                  <input value={urlForm.url} onChange={(e) => setUrlForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://your-cdn.com/spring-poster.jpg" className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-ink-max focus:outline-none focus:border-primary/50" />
                  <div className="flex gap-2">
                    <input value={urlForm.name} onChange={(e) => setUrlForm((f) => ({ ...f, name: e.target.value }))} placeholder="name (e.g. Spring Poster)" className="flex-1 bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-ink-max focus:outline-none focus:border-primary/50" />
                    <input value={urlForm.alt} onChange={(e) => setUrlForm((f) => ({ ...f, alt: e.target.value }))} placeholder="alt text" className="flex-1 bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-ink-max focus:outline-none focus:border-primary/50" />
                  </div>
                  <button onClick={addUrl} disabled={busy || !urlForm.url.trim()} className="flex items-center gap-1 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-[11px] disabled:opacity-30">
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} ADD LINK
                  </button>
                </>
              )}
              {tab === 'device' && (
                hasRepo ? (
                  <>
                    <div className="text-[11px] text-ink-max">Uploads commit straight into <span className="font-mono text-ink-max">{repo}</span> under <span className="font-mono">public/assets/</span>. Nothing is stored on Morpheus.</div>
                    <input ref={fileInputRef} type="file" accept="image/*,video/*,audio/*,.pdf,.woff2,.woff" className="hidden" onChange={(e) => addFile(e.target.files?.[0])} />
                    <button onClick={() => fileInputRef.current?.click()} disabled={busy} className="flex items-center gap-1 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-[11px] disabled:opacity-30">
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} CHOOSE FILE
                    </button>
                  </>
                ) : (
                  <div className="text-[11px] text-yellow-500/90 border border-yellow-500/30 px-2 py-2 leading-relaxed">
                    This project isn't connected to a GitHub repo yet — that's where uploads go.
                    Use <span className="text-primary">GITHUB COMPILE</span> / export to GitHub once, then upload here.
                    In the meantime you can <button onClick={() => setTab('url')} className="underline hover:text-yellow-300">add a link</button> to a file you host.
                  </div>
                )
              )}
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-matrix p-3">
              {!state && <div className="flex items-center gap-2 text-ink-strong text-xs"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
              {state && assets.length === 0 && <p className="text-ink-strong italic text-xs">No assets yet. Add a link or upload one above.</p>}
              <div className="grid grid-cols-2 gap-2">
                {assets.map((a) => <AssetCard key={a.id} asset={a} onDelete={del} />)}
              </div>
              {assets.some((a) => a.source === 'repo') && !state?.error && (
                <p className="text-[10px] text-ink-max mt-3 leading-relaxed">
                  Repo assets preview from <span className="font-mono">raw.githubusercontent.com</span> — that needs the repo to be public.
                  The deployed site serves them from <span className="font-mono">/assets/…</span> regardless.
                </p>
              )}
              <p className="text-[10px] text-ink-max mt-2">
                For a real connected library (Google Drive, your own bucket) — coming with the plugin. See <Link to="/settings" className="underline">Settings</Link>.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
