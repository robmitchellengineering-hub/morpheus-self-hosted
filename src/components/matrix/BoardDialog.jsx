import { useState, useEffect } from 'react';
import { Sliders, X, ArrowUp, ArrowDown, Trash2, Plus, AlertTriangle, Check, Power } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// The board: the plugin's signal path, arranged by the user.
//
// ── WHY THIS IS THE THING WORTH HAVING ───────────────────────────────────────────────────────────────────
// Every commercial multi-effect is a fixed set of blocks in a fixed order with a closed implementation. Here
// the blocks are GENERATED C++ that belongs to the user, the order is known at compile time (a block that is
// switched off compiles out), and the plugin and the device image come from this one drawing. The order a
// musician drags is the order the plugin runs — which is the whole feature, and it is also the thing that is
// easy to get wrong quietly: a block that is drawn but not emitted, or one that is emitted but renumbers the
// controls a host has automated.
//
// ── IT SAVES INTO THE PROJECT, AND IT DOES NOT COMPILE ───────────────────────────────────────────────────
// Saving writes `morpheus.plugin.json` — the project's own file, which the user can read and edit. Nothing
// is built until COMPILE is pressed: an arrangement is edited many times and compiled once.
//
// ── ⚠️ ARROWS, NOT DRAG ───────────────────────────────────────────────────────────────────────────────────
// Dragging is the obvious gesture and it is the wrong one here: HTML5 drag-and-drop does not fire on a touch
// screen, so a phone — which is where a musician is most likely to be holding this — would be able to see the
// board and not reorder it. Two buttons work everywhere, are reachable by keyboard, and say what they do.
const fmt = (v) => (Number.isInteger(Number(v)) ? String(Number(v)) : Number(v).toFixed(1));

function Control({ control, value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-primary/50 tracking-[0.2em] font-display w-16 shrink-0">{control.name.toUpperCase()}</span>
      <input
        type="range"
        min={control.min}
        max={control.max}
        step="0.1"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-primary h-1"
      />
      <span className="text-[11px] text-ink-max font-mono tabular-nums w-12 text-right">{fmt(value)}</span>
    </div>
  );
}

export default function BoardDialog({ open, onClose, projectId }) {
  const [view, setView] = useState(null);
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setView(null); setErr(null); setStatus(null);
    base44.functions.getBoard(projectId)
      .then((data) => { setView(data); setItems(data.board?.items || []); })
      .catch((e) => setErr(e?.data?.error || e.message));
  }, [open, projectId]);

  if (!open) return null;

  const blocks = view?.blocks || [];
  const catalogue = view?.catalogue || [];
  const blockOf = (kind) => blocks.find((b) => b.kind === kind) || catalogue.find((c) => c.kind === kind);
  const used = new Set(items.map((i) => i.kind));
  const addable = catalogue.filter((c) => !used.has(c.kind) && c.pinned !== 'last');
  const warnings = view?.warnings || [];

  // The order is the document, so every edit rebuilds it rather than mutating it in place — a mutation is how
  // two rows end up sharing an object and a slider moves a block the user is not looking at.
  const replace = (next) => setItems(next);
  const move = (at, by) => {
    const to = at + by;
    if (to < 0 || to >= items.length) return;
    // Output stays last: the emitted loop applies the level on the plugin's output, so a block drawn after it
    // would be processed after the level had already been set. Moving it is refused here and by the server.
    if (items[at].kind === 'output' || items[to].kind === 'output') return;
    const next = items.slice();
    const [it] = next.splice(at, 1);
    next.splice(to, 0, it);
    replace(next);
  };
  const toggle = (at) => replace(items.map((it, i) => (i === at ? { ...it, enabled: it.enabled === false } : it)));
  const remove = (at) => replace(items.filter((_, i) => i !== at));
  const add = (kind) => {
    const at = items.findIndex((i) => i.kind === 'output');
    const instanceId = Math.max(0, ...items.map((i) => Number(i.instanceId) || 0)) + 1;
    const next = items.slice();
    next.splice(at < 0 ? next.length : at, 0, { instanceId, kind, enabled: true, values: {} });
    replace(next);
  };
  const setValue = (at, key, value) => replace(items.map((it, i) => (i === at ? { ...it, values: { ...it.values, [key]: value } } : it)));

  const save = async () => {
    setErr(null); setStatus(null); setBusy(true);
    try {
      const data = await base44.functions.saveBoard(projectId, {
        items, nextInstanceId: Math.max(0, ...items.map((i) => Number(i.instanceId) || 0)) + 1,
      });
      setView(data);
      setItems(data.board?.items || []);
      setStatus('Saved. COMPILE writes this into the plugin.');
    } catch (e) {
      // A refusal is the server's validation, and it names the block — shown as it arrives rather than
      // softened, because the fix is in the row it names.
      setErr((e?.data?.errors || [e?.data?.error || e.message]).join(' '));
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto scrollbar-matrix border border-primary/40 bg-background shadow-[0_0_20px_rgba(0,255,65,0.2)]">
        <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3 sticky top-0 bg-background z-10">
          <div className="flex items-center gap-2">
            <Sliders size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider neon-glow">SIGNAL PATH</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <div className="p-4 space-y-4 text-xs text-ink-strong leading-relaxed">
          <p>
            This is the plugin&apos;s <span className="text-ink-strong">signal path</span>, top to bottom — the same order
            the audio runs in, and the same order the compiled plugin will use. Move a block with the arrows,
            switch one off without losing its settings, and set its controls here: these are the plugin&apos;s
            defaults.
          </p>

          {view === null && !err && <p className="text-ink-strong">Loading…</p>}

          {items.length > 0 && (
            <div className="space-y-1">
              {items.map((item, at) => {
                const b = blockOf(item.kind);
                if (!b) return null;
                const off = item.enabled === false;
                const pinned = b.pinned === 'last';
                return (
                  <div key={item.instanceId} className={`border ${off ? 'border-primary/15 opacity-60' : 'border-primary/30'} px-2 py-2 space-y-2`}>
                    <div className="flex items-center gap-2">
                      <span className="text-ink-max font-mono text-[10px] w-5 text-right">{at + 1}</span>
                      <span className={`font-display tracking-wider ${off ? 'text-ink-strong' : 'text-primary'}`}>{b.label.toUpperCase()}</span>
                      {off && <span className="text-[10px] text-yellow-500/80">BYPASSED</span>}
                      {b.needs && !items.some((i) => i.kind === b.needs) && (
                        <span className="text-[10px] text-ink-max">no {b.needs === 'model' ? '.nam' : '.wav'} in this project</span>
                      )}
                      <span className="flex-1" />
                      {!pinned && (
                        <>
                          <button onClick={() => move(at, -1)} disabled={at === 0} className="text-primary/60 hover:text-primary disabled:opacity-20" title="Move up"><ArrowUp size={14} /></button>
                          <button onClick={() => move(at, 1)} disabled={at === items.length - 1} className="text-primary/60 hover:text-primary disabled:opacity-20" title="Move down"><ArrowDown size={14} /></button>
                          <button onClick={() => toggle(at)} className={off ? 'text-primary/40 hover:text-primary' : 'text-primary'} title={off ? 'Switch on' : 'Bypass'}><Power size={14} /></button>
                          <button onClick={() => remove(at)} className="text-primary/60 hover:text-red-400" title="Remove"><Trash2 size={14} /></button>
                        </>
                      )}
                      {pinned && <span className="text-[10px] text-primary/40 tracking-wider">LAST</span>}
                    </div>
                    {(b.controls || []).length > 0 && (
                      <div className="space-y-1.5 pl-7">
                        {(b.controls || []).map((c) => (
                          <Control
                            key={c.key}
                            control={c}
                            value={Number.isFinite(Number(item.values?.[c.key])) ? Number(item.values[c.key]) : c.def}
                            onChange={(v) => setValue(at, c.key, v)}
                          />
                        ))}
                      </div>
                    )}
                    {at < items.length - 1 && <div className="text-center text-primary/25 leading-none">↓</div>}
                  </div>
                );
              })}
            </div>
          )}

          {addable.length > 0 && (
            <div className="border-t border-primary/20 pt-3 space-y-2">
              <div className="text-[10px] text-primary/50 tracking-[0.2em] font-display">ADD A BLOCK</div>
              <div className="flex flex-wrap gap-1.5">
                {addable.map((c) => (
                  <button
                    key={c.kind}
                    onClick={() => add(c.kind)}
                    className="flex items-center gap-1 border border-primary/40 px-2 py-1 text-[11px] text-primary/80 hover:border-primary hover:text-primary"
                    title={c.blurb}
                  >
                    <Plus size={12} /> {c.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-ink-max">
                One of each for now. Two blocks of the same kind would share their parameter ids, and a control
                id is what a host stores its automation against — so the second one is refused rather than
                silently sharing.
              </p>
            </div>
          )}

          {/* ⚠️ THE WARNINGS ARE THE POINT OF THE PANEL, not decoration: "there is a model block but no .nam"
              is the difference between a plugin that sounds like the amp and one that sounds like nothing. */}
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

          <div className="flex gap-2 border-t border-primary/20 pt-3">
            <button
              onClick={save}
              disabled={busy || !items.length}
              className="flex-1 py-2 border border-primary text-primary hover:bg-primary hover:text-black transition-colors font-bold disabled:opacity-30"
            >
              {busy ? 'SAVING…' : 'SAVE THE SIGNAL PATH'}
            </button>
            <button onClick={onClose} className="px-3 py-2 border border-primary/30 text-primary/70 hover:text-primary">
              CLOSE
            </button>
          </div>
          <p className="text-[10px] text-ink-max">
            Saving does not build anything. The plugin is generated on the next COMPILE, from this drawing.
          </p>
        </div>
      </div>
    </div>
  );
}
