import { useState, useEffect } from 'react';
import JSZip from 'jszip';

const FILES = [
  'package.json',
  'README.md',
  'server/index.js',
  'server/store.js',
  'server/llm.js',
  'server/reviewer.js',
  'server/morpheus.js',
  'client/api.js',
  'client/Morpheus.jsx',
  'client/MorpheusPanel.jsx',
];

export default function PortableMorpheusDownload() {
  const [status, setStatus] = useState('zipping…');
  const [err, setErr] = useState(null);

  const download = async () => {
    try {
      setErr(null);
      setStatus('fetching files…');
      const zip = new JSZip();
      const root = zip.folder('portable-morpheus');
      for (const p of FILES) {
        const res = await fetch(`${import.meta.env.BASE_URL}portable-morpheus/${p}`);
        if (!res.ok) throw new Error(`fetch ${p}: ${res.status}`);
        root.file(p, await res.text());
      }
      // Append the synced real-source mirror (kept current by
      // scripts/sync-portable-morpheus.mjs) so the bundle ships the latest
      // development code alongside the standalone portable adapters.
      let synced = [];
      try {
        const mres = await fetch(`${import.meta.env.BASE_URL}portable-morpheus/_source/manifest.json`);
        if (mres.ok) synced = (await mres.json()).files || [];
      } catch { /* no manifest yet — bundle the hand-written files only */ }
      for (const p of synced) {
        const res = await fetch(`${import.meta.env.BASE_URL}portable-morpheus/_source/${p}`);
        if (!res.ok) continue;
        root.file(`_source/${p}`, await res.text());
      }
      setStatus('zipping…');
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'portable-morpheus.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus('done');
    } catch (e) {
      setErr(e.message);
      setStatus('error');
    }
  };

  useEffect(() => { download(); }, []);

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-black text-primary font-mono p-6">
      <div className="text-center">
        <div className="text-lg tracking-wider neon-glow mb-2">◇ PORTABLE MORPHEUS</div>
        <div className="text-xs text-primary/60">{FILES.length} files · {status}</div>
      </div>
      {err && <div className="text-red-500 text-xs max-w-xs text-center">Error: {err}</div>}
      {status === 'done' && <div className="text-xs text-primary/80">✓ Download started. Check your downloads.</div>}
      <button onClick={download} className="mt-2 px-4 py-2 border border-primary text-primary hover:bg-primary hover:text-black text-xs font-bold tracking-wider">
        DOWNLOAD AGAIN
      </button>
    </div>
  );
}