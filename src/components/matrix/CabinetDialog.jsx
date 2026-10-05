import { useState, useEffect, useRef } from 'react';
import { Sliders, X, Upload, Trash2, AlertTriangle, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// The cabinet: put the speaker in the plugin.
//
// WHY A DIALOG RATHER THAN THE MEDIA PANEL. An amp model is the amplifier; the speaker is a separate
// convolution, and without it a modelled amp sounds like a bee in a jar. The Media panel's upload commits a
// file into the project's GITHUB REPO and keeps no bytes — and the code that bakes the cabinet into the
// plugin runs on the Morpheus server, from the project's files, BEFORE anything is pushed. So a .wav in the
// repo cannot reach it, and this stores the bytes where the compile can fetch them. Rob, 2026-10-05: chose
// this over "point at a URL you host", because it means Morpheus never dials an address a user typed.
//
// THE LIMITS ARE STATED HERE, not discovered later: a cabinet longer than 4096 taps is truncated (with the
// tail dropped and said so, at build time), and a 44.1 kHz cabinet is used as-is and will sound shifted.
const ACCEPT = '.wav,audio/wav,audio/x-wav,audio/*';
const MAX_MB = 16;

export default function CabinetDialog({ open, onClose, projectId }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState(null);
  const fileRef = useRef(null);

  const load = async () => {
    try {
      const data = await base44.functions.listCabinets(projectId);
      setRows(data.cabinets || []);
    } catch (e) { setErr(e?.data?.error || e.message); }
  };

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setUploaded(null);
    setRows(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  if (!open) return null;

  const pick = async (file) => {
    if (!file) return;
    setErr(null);
    setUploaded(null);
    if (file.size > MAX_MB * 1024 * 1024) {
      setErr(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_MB} MB.`);
      return;
    }
    setBusy(true);
    try {
      // Through the client wrapper, which adds the bearer token and leaves FormData alone — a multipart body
      // with a JSON content-type is the classic way an upload arrives empty.
      const form = new FormData();
      form.append('file', file);
      const data = await base44.functions.addCabinet(projectId, form);
      setUploaded(data.cabinet?.path || file.name);
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const remove = async (id) => {
    setErr(null);
    try {
      await base44.functions.deleteCabinet(projectId, id);
      await load();
    } catch (e) { setErr(e?.data?.error || e.message); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto scrollbar-matrix border border-primary/40 bg-background shadow-[0_0_20px_rgba(0,255,65,0.2)]">
        <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3 sticky top-0 bg-background">
          <div className="flex items-center gap-2">
            <Sliders size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider neon-glow">CABINET</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <div className="p-4 space-y-4 text-xs text-ink-strong leading-relaxed">
          <p>
            A <span className="text-ink-strong">.nam</span> model is usually the <span className="text-ink-strong">amplifier</span>.
            The <span className="text-ink-strong">speaker</span> is a separate convolution, and without one a modelled amp
            sounds like a bee in a jar. Put your cabinet impulse response here and it is baked into the plugin on your
            next compile — nothing to install beside it.
          </p>

          {rows === null && <p className="text-ink-strong">Loading…</p>}

          {rows !== null && rows.length === 0 && (
            <p className="text-yellow-500/90 border border-yellow-500/30 px-2 py-2">
              No cabinet yet. The plugin will build and sound like the amplifier on its own.
            </p>
          )}

          {rows !== null && rows.length > 0 && (
            <div className="space-y-1.5">
              {rows.map((r) => (
                <div key={r.id} className="flex items-center gap-2 border border-primary/30 px-2 py-1.5">
                  <span className="text-ink-strong truncate flex-1">{r.path}</span>
                  {!r.stored && (
                    <span className="text-yellow-500/90 flex items-center gap-1"><AlertTriangle size={12} /> not stored</span>
                  )}
                  {r.size != null && <span className="text-ink-strong">{r.size.toLocaleString()} bytes</span>}
                  <button onClick={() => remove(r.id)} className="text-primary/60 hover:text-red-400"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}

          {uploaded && (
            <p className="text-ink-strong flex items-center gap-1"><Check size={12} /> {uploaded} uploaded — compile to bake it in.</p>
          )}

          <div className="border-t border-primary/20 pt-3 space-y-2">
            <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
            <button onClick={() => fileRef.current?.click()} disabled={busy}
              className="w-full flex items-center justify-center gap-2 py-2 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary disabled:opacity-30">
              {busy ? <Sliders size={14} className="animate-pulse" /> : <Upload size={14} />} CHOOSE .WAV
            </button>
            {/* ⚠️ SAID HERE, NOT DISCOVERED LATER. Both of these are real limits of the current build and both
                change how the cabinet sounds; a user who is told afterwards has already blamed the cabinet. */}
            <p className="text-[10px] text-ink-max">
              A WAV, up to {MAX_MB} MB. Only the first 4096 samples are convolved (~85 ms at 48 kHz) — a longer
              tail is dropped, and the build says so. A 44.1 kHz cabinet is used as-is and will sound shifted;
              48 kHz is what the plugin runs at.
            </p>
          </div>

          {err && <p className="text-red-500/90">{err}</p>}
        </div>
      </div>
    </div>
  );
}
