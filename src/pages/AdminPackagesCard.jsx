// AdminPackagesCard.jsx — publish the SDK from the admin panel, because the admin is already signed in.
//
// Rob, 2026-11-02: "we usually just add a page to morpheus.nz all the info and creds should be in there to publish". He is right, and
// the token ceremony I proposed was a workaround for a problem that does not exist: this page runs with the admin's own session, which
// publishPackage already accepts. A token remains useful for a build machine, not for a person.
import { useEffect, useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

const fmt = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`);

export default function AdminPackagesCard() {
  const [index, setIndex] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await base44.functions.invoke('listPackages', {});
      setIndex(r.data ?? r);
      setError('');
    } catch (e) { setError(e?.message ?? 'could not read the registry'); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const publish = async () => {
    if (!file) { setError('choose a .tgz first'); return; }
    setBusy(true); setError(''); setResult(null);
    try {
      // A TARBALL IS SENT AS BASE64 over the same JSON channel every other function uses: no new upload route, no new credential.
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('could not read the file'));
        reader.readAsDataURL(file);
      });
      const r = await base44.functions.invoke('publishPackage', {
        name: 'valiant-verification-sdk',
        version: version || undefined,
        notes: notes || undefined,
        tarball: base64,
      });
      setResult(r.data ?? r);
      setFile(null); setVersion(''); setNotes('');
      await load();
    } catch (e) { setError(e?.response?.data?.error ?? e?.message ?? 'publish failed'); }
    finally { setBusy(false); }
  };

  const versions = index?.packages?.['valiant-verification-sdk'] ?? [];

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold tracking-wide">PACKAGES</h3>
        <button onClick={load} className="text-xs text-ink-muted hover:text-foreground">REFRESH</button>
      </div>
      <p className="text-xs text-ink-muted mb-4">
        Published builds of the SDK. Customers install with{' '}
        <code className="text-[11px]">npm install -g "https://api.morpheus.nz/api/functions/getPackage?name=valiant-verification-sdk&amp;version=latest"</code>
      </p>

      {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
      {result?.ok && (
        <p className="text-xs font-medium mb-3">
          Published {result.name}@{result.version} · {fmt(result.size)} · sha256 {String(result.sha256).slice(0, 16)}…
        </p>
      )}

      <div className="space-y-2 mb-5">
        {versions.length === 0 && <p className="text-xs text-ink-muted">Nothing published yet.</p>}
        {versions.map((v) => (
          <div key={v.version} className="flex items-center justify-between text-xs border-b border-border/50 pb-1">
            <span className="font-mono">{v.version}</span>
            <span className="text-ink-muted">{fmt(v.size)} · {v.date}</span>
            <span className="font-mono text-ink-muted">{String(v.sha256).slice(0, 12)}…</span>
          </div>
        ))}
      </div>

      <div className="grid gap-2">
        <input
          type="file"
          accept=".tgz,application/gzip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-xs"
        />
        <div className="grid grid-cols-2 gap-2">
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="version (blank = from file name)"
            className="text-xs bg-background border border-border rounded px-2 py-1"
          />
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="what changed"
            className="text-xs bg-background border border-border rounded px-2 py-1"
          />
        </div>
        <button
          onClick={publish}
          disabled={busy || !file}
          className="text-xs font-semibold tracking-wide rounded px-3 py-2 border border-primary/60 text-primary hover:bg-primary/10 disabled:opacity-50"
        >
          {busy ? 'PUBLISHING…' : 'PUBLISH'}
        </button>
      </div>
    </div>
  );
}
