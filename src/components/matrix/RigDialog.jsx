import { useState, useEffect, useRef } from 'react';
import { Sliders, X, Upload, Trash2, AlertTriangle, Check, ArrowUp, ArrowDown, Plus, MinusCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// THE RIG: one amplifier caught in several of its states, and one cabinet through several mics.
//
// ── WHY THIS IS THE SURFACE FOR IT ───────────────────────────────────────────────────────────────────────
// A project used to think in ONE `.nam` and ONE `.wav`, and the plugin can already switch between a whole
// rig — but the only way to give a project more than one capture was to hand-edit `morpheus.plugin.json`, or
// to know that dropping extra files in happened to work and that their names would come from their
// FILENAMES. Rob's own model is the one this draws: *"you'd have a collection of nams and irs for the one
// rig and that overarching rig name hosts all the nams and irs for that rig."*
//
// So this is the same kind of thing the SIGNAL PATH dialog is: a list the user arranges, saved into the
// project's own manifest, read by the generator on the next compile. It is a separate dialog rather than a
// section of the signal path because it is a separate document — the board is WHICH BLOCKS and in what
// order; the rig is WHICH CAPTURE and WHICH SPEAKER those two blocks select between — and the manifest
// already stores them as two keys for exactly that reason.
//
// ── WHAT A NAME IS FOR ───────────────────────────────────────────────────────────────────────────────────
// The name in the box is what a player reads in the plugin's Capture/Speaker control — a DAW's automation
// lane included. Without one, the name is derived from the filename, and a filename is the one thing a name
// is guaranteed not to be: `JCM800 2203 Crunch 2 (No pre amp bass cut).nam`. Typing a name is what writes
// the explicit list, which also freezes the rig: after that, a capture added later is listed under "also in
// this project" rather than silently joining.
//
// ⚠️ IT SAVES INTO THE PROJECT, AND IT DOES NOT COMPILE — the same contract as the board.
const MAX_NAM_MB = 32;
const MAX_WAV_MB = 16;

function Half({ title, blurb, side, members, others, onRename, onMove, onOut, onIn, onDelete, busy }) {
  return (
    <div className="border border-primary/25 px-3 py-3 space-y-2">
      <div className="text-[10px] text-primary/60 tracking-[0.2em] font-display">{title}</div>
      <p className="text-[10px] text-ink-max leading-relaxed">{blurb}</p>

      {members.length === 0 && <p className="text-yellow-500/90 text-[11px]">None in the rig yet.</p>}

      <div className="space-y-1">
        {members.map((m, at) => (
          <div key={m.path} className={`border ${m.usable ? 'border-primary/30' : 'border-yellow-500/40'} px-2 py-1.5 space-y-1`}>
            <div className="flex items-center gap-1.5">
              <span className="text-ink-max font-mono text-[10px] w-4 text-right">{at + 1}</span>
              <input
                value={m.name}
                onChange={(e) => onRename(side, at, e.target.value)}
                spellCheck={false}
                className="flex-1 min-w-0 bg-transparent border border-primary/25 focus:border-primary/70 outline-none text-[11px] px-1.5 py-0.5 text-ink-strong"
                placeholder="the name a player reads"
              />
              <button onClick={() => onMove(side, at, -1)} disabled={at === 0} className="text-primary/60 hover:text-primary disabled:opacity-20" title="Earlier in the list"><ArrowUp size={13} /></button>
              <button onClick={() => onMove(side, at, 1)} disabled={at === members.length - 1} className="text-primary/60 hover:text-primary disabled:opacity-20" title="Later in the list"><ArrowDown size={13} /></button>
              <button onClick={() => onOut(side, at)} className="text-primary/60 hover:text-primary" title="Take out of the rig — the file stays in the project"><MinusCircle size={13} /></button>
              <button onClick={() => onDelete(side, m)} className="text-primary/60 hover:text-red-400" title="Delete this file from the project"><Trash2 size={13} /></button>
            </div>
            <div className="flex items-center gap-2 pl-5">
              <span className="text-[10px] text-ink-max font-mono truncate">{m.path}</span>
              {!m.usable && <span className="text-[10px] text-yellow-500/90 shrink-0">NOT USABLE — it will be left out of the plugin</span>}
            </div>
          </div>
        ))}
      </div>

      {others.length > 0 && (
        <div className="border-t border-primary/15 pt-2 space-y-1">
          <div className="text-[10px] text-primary/50 tracking-[0.15em] font-display">ALSO IN THIS PROJECT</div>
          {others.map((o) => (
            <div key={o.path} className="flex items-center gap-1.5">
              <span className="text-ink-strong text-[11px] truncate flex-1">{o.name}</span>
              <span className="text-[10px] text-ink-max font-mono truncate max-w-[45%]">{o.path}</span>
              <button onClick={() => onIn(side, o)} disabled={busy} className="text-primary/70 hover:text-primary disabled:opacity-30" title="Add it to the rig"><Plus size={13} /></button>
              <button onClick={() => onDelete(side, o)} className="text-primary/60 hover:text-red-400" title="Delete this file from the project"><Trash2 size={13} /></button>
            </div>
          ))}
          <p className="text-[10px] text-ink-max">The rig is a chosen list, so these are in the project and not in the plugin.</p>
        </div>
      )}
    </div>
  );
}

export default function RigDialog({ open, onClose, projectId }) {
  const [view, setView] = useState(null);
  const [members, setMembers] = useState({ models: [], cabs: [] });
  const [others, setOthers] = useState({ models: [], cabs: [] });
  const [err, setErr] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const namRef = useRef(null);
  const wavRef = useRef(null);

  const apply = (data) => {
    setView(data);
    setMembers({ models: data.models?.members || [], cabs: data.cabs?.members || [] });
    setOthers({ models: data.models?.others || [], cabs: data.cabs?.others || [] });
  };

  const load = async () => {
    try { apply(await base44.functions.getRig(projectId)); }
    catch (e) { setErr(e?.data?.error || e.message); }
  };

  useEffect(() => {
    if (!open) return;
    setView(null); setErr(null); setStatus(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  if (!open) return null;

  // The working lists are rebuilt rather than mutated — the same rule the board dialog follows, so two rows
  // can never end up sharing an object and a rename cannot move a capture the user is not looking at.
  const rename = (side, at, name) => setMembers((m) => ({ ...m, [side]: m[side].map((x, i) => (i === at ? { ...x, name } : x)) }));
  const move = (side, at, by) => setMembers((m) => {
    const to = at + by;
    if (to < 0 || to >= m[side].length) return m;
    const next = m[side].slice();
    const [it] = next.splice(at, 1);
    next.splice(to, 0, it);
    return { ...m, [side]: next };
  });
  const out = (side, at) => {
    const entry = members[side][at];
    if (!entry) return;
    setMembers((m) => ({ ...m, [side]: m[side].filter((_, i) => i !== at) }));
    // It lands under "also in this project" rather than vanishing, because that is exactly what it now is —
    // and the next load would list it there anyway, so hiding it until then would be a lie about the save.
    setOthers((o) => ({ ...o, [side]: [...o[side], entry] }));
  };
  const into = (side, entry) => {
    setMembers((m) => ({ ...m, [side]: [...m[side], entry] }));
    setOthers((o) => ({ ...o, [side]: o[side].filter((x) => x.path !== entry.path) }));
  };
  const del = async (side, entry) => {
    if (!entry.id) { setErr(`${entry.path} has no stored row, so it cannot be deleted from here.`); return; }
    setErr(null); setStatus(null); setBusy(true);
    try {
      if (side === 'models') await base44.functions.deleteCapture(projectId, entry.id);
      else await base44.functions.deleteCabinet(projectId, entry.id);
      await load();
      setStatus(`${entry.path} deleted.`);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const addFile = async (side, file) => {
    if (!file) return;
    setErr(null); setStatus(null);
    const limit = side === 'models' ? MAX_NAM_MB : MAX_WAV_MB;
    if (file.size > limit * 1024 * 1024) {
      setErr(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${limit} MB.`);
      return;
    }
    setBusy(true);
    try {
      // Through the client wrapper, which adds the bearer token and leaves FormData alone — a multipart body
      // with a JSON content-type is the classic way an upload arrives empty.
      const form = new FormData();
      form.append('file', file);
      if (side === 'models') await base44.functions.addCapture(projectId, form);
      else await base44.functions.addCabinet(projectId, form);
      await load();
      setStatus(`${file.name} added.`);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally {
      setBusy(false);
      if (namRef.current) namRef.current.value = '';
      if (wavRef.current) wavRef.current.value = '';
    }
  };

  const save = async (payload) => {
    setErr(null); setStatus(null); setBusy(true);
    try {
      const data = await base44.functions.saveRig(projectId, payload);
      apply(data);
      setStatus('Saved. COMPILE bakes this rig into the plugin, and it is what the Capture and Speaker controls offer.');
    } catch (e) {
      // A refusal is the server's validation, and it names the entry — shown as it arrives rather than
      // softened, because the fix is in the row it names.
      setErr((e?.data?.errors || [e?.data?.error || e.message]).join(' '));
    } finally { setBusy(false); }
  };

  const saveRig = () => save({
    models: members.models.map((m) => ({ path: m.path, name: m.name })),
    cabs: members.cabs.map((c) => ({ path: c.path, name: c.name })),
  });
  // ⚠️ CLEARING IS ITS OWN ACTION, because it is the opposite of what saving means. An empty list would read
  // to the finder as "this project did not ask for a rig" and quietly put every file back — so "follow the
  // project" removes the key instead, and the whole file list is in the rig again.
  const followProject = () => save({ models: null, cabs: null });

  const warnings = view?.warnings || [];
  const usableModels = members.models.filter((m) => m.usable).length;
  const usableCabs = members.cabs.filter((c) => c.usable).length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto scrollbar-matrix border border-primary/40 bg-background shadow-[0_0_20px_rgba(0,255,65,0.2)]">
        <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3 sticky top-0 bg-background z-10">
          <div className="flex items-center gap-2">
            <Sliders size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider neon-glow">RIG — CAPTURES &amp; MICS</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <div className="p-4 space-y-4 text-xs text-ink-strong leading-relaxed">
          <p>
            One amplifier, captured in several of its states, and one cabinet, heard through several mics. Each
            capture and each mic is a row below; the plugin offers them in this order in its own{' '}
            <span className="text-primary">Capture</span> and <span className="text-primary">Speaker</span> controls,
            and opens on the first of each. The name you type is what a player reads there — a DAW&apos;s automation
            lane included.
          </p>

          {view === null && !err && <p className="text-ink-strong">Loading…</p>}

          {view !== null && (
            <>
              <Half
                title={`CAPTURES — ${usableModels} IN THE PLUGIN`}
                blurb="The amplifier, in its settings. Four `.nam` files is a four-way Capture control."
                side="models"
                members={members.models}
                others={others.models}
                onRename={rename} onMove={move} onOut={out} onIn={into} onDelete={del}
                busy={busy}
              />
              <Half
                title={`MICS — ${usableCabs} IN THE PLUGIN`}
                blurb="The cabinet, through the microphones it was recorded with. Each one convolves instead of the others."
                side="cabs"
                members={members.cabs}
                others={others.cabs}
                onRename={rename} onMove={move} onOut={out} onIn={into} onDelete={del}
                busy={busy}
              />

              <div className="border border-primary/20 px-3 py-2 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <input ref={namRef} type="file" accept=".nam,application/json" className="hidden" onChange={(e) => addFile('models', e.target.files?.[0])} />
                  <input ref={wavRef} type="file" accept=".wav,audio/wav,audio/x-wav,audio/*" className="hidden" onChange={(e) => addFile('cabs', e.target.files?.[0])} />
                  <button onClick={() => namRef.current?.click()} disabled={busy}
                    className="flex items-center gap-1.5 border border-primary/50 px-2 py-1 text-[11px] text-primary/80 hover:border-primary hover:text-primary disabled:opacity-30">
                    <Upload size={12} /> ADD A CAPTURE (.nam)
                  </button>
                  <button onClick={() => wavRef.current?.click()} disabled={busy}
                    className="flex items-center gap-1.5 border border-primary/50 px-2 py-1 text-[11px] text-primary/80 hover:border-primary hover:text-primary disabled:opacity-30">
                    <Upload size={12} /> ADD A MIC (.wav)
                  </button>
                </div>
                <p className="text-[10px] text-ink-max">
                  A `.nam` is checked the moment it arrives, with the generator&apos;s own inspector — a capture that
                  will not parse is refused here rather than built into a plugin that plays nothing. A `.wav` is a
                  cabinet impulse response: up to {MAX_WAV_MB} MB, and only its first 4096 samples are convolved.
                </p>
              </div>

              {warnings.length > 0 && (
                <div className="border border-yellow-500/30 bg-yellow-500/5 px-2 py-2 space-y-1">
                  {warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-[10px] text-yellow-500/90">
                      <AlertTriangle size={11} className="mt-0.5 shrink-0" /> <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {status && <p className="text-ink-strong flex items-center gap-1"><Check size={12} /> {status}</p>}
              {err && <p className="text-red-500/90">{err}</p>}

              <div className="flex flex-wrap gap-2 border-t border-primary/20 pt-3">
                <button
                  onClick={saveRig}
                  disabled={busy || !members.models.length}
                  className="flex-1 py-2 border border-primary text-primary hover:bg-primary hover:text-black transition-colors font-bold disabled:opacity-30"
                >
                  {busy ? 'SAVING…' : 'SAVE THE RIG'}
                </button>
                {!view.models.auto || !view.cabs.auto ? (
                  <button onClick={followProject} disabled={busy}
                    className="px-3 py-2 border border-primary/30 text-primary/70 hover:text-primary disabled:opacity-30"
                    title="Remove the rig from the manifest, so every capture and mic in the project is offered again">
                    FOLLOW THE PROJECT
                  </button>
                ) : null}
                <button onClick={onClose} className="px-3 py-2 border border-primary/30 text-primary/70 hover:text-primary">
                  CLOSE
                </button>
              </div>
              <p className="text-[10px] text-ink-max">
                Saving does not build anything — the plugin is generated on the next COMPILE, from this list. With no
                rig saved, every `.nam` and `.wav` in the project is offered, named from its filename.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
