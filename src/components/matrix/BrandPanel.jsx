import { useState, useEffect, useCallback } from 'react';
import { X, Palette, Loader2, Check, Type as TypeIcon } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Brand kit (2026-09-09) — the project's colours, fonts, radius, density,
// logo and voice. Stored as .morpheus/brand.json in the project (travels with
// export / repo). On a web build these become HARD token values the coder
// must use — "match my brand" stops being a guess.

const COLOR_ROLES = [
  ['primary', 'Primary', 'buttons, links, key accents'],
  ['accent', 'Accent', 'highlights, secondary actions'],
  ['bg', 'Background', 'page background'],
  ['surface', 'Surface', 'cards, panels'],
  ['text', 'Text', 'body copy'],
  ['muted', 'Muted text', 'captions, meta'],
];

const DENSITIES = ['compact', 'comfortable', 'spacious'];

export default function BrandPanel({ open, onClose, projectId, onSetChange }) {
  const [state, setState] = useState(null); // { brand, set, fonts, isWeb }
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const { data } = await base44.functions.invoke('getProjectBrand', { projectId });
      setState(data);
      setDraft(JSON.parse(JSON.stringify(data.brand)));
    } catch (e) {
      setErr(e?.data?.error || e.message);
    }
  }, [projectId]);

  useEffect(() => { if (open) { setSaved(false); setErr(null); load(); } }, [open, load]);

  if (!open) return null;

  const set = (path, value) => {
    setDraft((d) => {
      const next = JSON.parse(JSON.stringify(d));
      const keys = path.split('.');
      let o = next;
      for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
      o[keys[keys.length - 1]] = value;
      return next;
    });
    setSaved(false);
  };

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const { data } = await base44.functions.invoke('saveProjectBrand', { projectId, brand: draft });
      setState((s) => ({ ...s, brand: data.brand, set: true }));
      setDraft(JSON.parse(JSON.stringify(data.brand)));
      setSaved(true);
      onSetChange?.(true);
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  };

  const b = draft;
  const fonts = state?.fonts || [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div className="bg-background border-l border-primary/40 w-full max-w-md h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <Palette size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">BRAND KIT</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <p className="text-[11px] text-ink/45 leading-relaxed px-4 py-2 border-b border-primary/10">
          Colours, type and voice for this site. On a web build the builder is given these as hard constraints —
          it defines them as CSS variables and uses them everywhere.
          {state && state.isWeb === false && <span className="text-yellow-500/80"> This project isn't a web-app target, so the brand won't be applied.</span>}
        </p>

        {!b && <div className="p-4 flex items-center gap-2 text-ink/60 text-xs"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
        {err && <div className="m-4 text-red-400 text-xs border border-red-500/30 px-3 py-2">{err}</div>}

        {b && (
          <>
            <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-5">
              {/* Colours */}
              <section>
                <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2">Colours</div>
                <div className="space-y-2">
                  {COLOR_ROLES.map(([key, label, hint]) => (
                    <div key={key} className="flex items-center gap-3">
                      <input type="color" value={b.colors[key]} onChange={(e) => set(`colors.${key}`, e.target.value)}
                        className="w-8 h-8 bg-transparent border border-primary/30 cursor-pointer shrink-0" />
                      <input value={b.colors[key]} onChange={(e) => set(`colors.${key}`, e.target.value)}
                        className="w-24 bg-black/30 border border-primary/20 px-2 py-1 text-[11px] text-primary font-mono focus:outline-none focus:border-primary/50" />
                      <div className="min-w-0">
                        <div className="text-[11px] text-ink/75">{label}</div>
                        <div className="text-[10px] text-ink/40 truncate">{hint}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Type */}
              <section>
                <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2 flex items-center gap-1.5"><TypeIcon size={12} /> Type</div>
                <div className="grid grid-cols-2 gap-3">
                  {['heading', 'body'].map((slot) => (
                    <label key={slot} className="block">
                      <span className="text-[10px] text-primary/45 uppercase">{slot}</span>
                      <select value={b.fonts[slot]} onChange={(e) => set(`fonts.${slot}`, e.target.value)}
                        className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-primary focus:outline-none focus:border-primary/50 mt-0.5">
                        {fonts.map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                <div className="mt-2 border border-primary/15 bg-black/20 p-3">
                  <div style={{ fontFamily: `'${b.fonts.heading}', sans-serif` }} className="text-ink text-base">The quick brown fox</div>
                  <div style={{ fontFamily: `'${b.fonts.body}', sans-serif` }} className="text-ink/70 text-[11px] mt-1">jumps over the lazy dog — body copy sample at a small size.</div>
                </div>
              </section>

              {/* Shape */}
              <section>
                <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2">Shape</div>
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-[11px] text-ink/60 w-16">Radius</span>
                  <input type="range" min="0" max="24" value={parseInt(b.radius) || 0}
                    onChange={(e) => set('radius', `${e.target.value}px`)} className="flex-1 accent-[color:var(--primary,#4f8cff)]" />
                  <span className="text-[11px] text-ink/70 font-mono w-10 text-right">{b.radius}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-ink/60 w-16">Density</span>
                  <div className="flex border border-primary/30">
                    {DENSITIES.map((d) => (
                      <button key={d} onClick={() => set('density', d)}
                        className={`text-[10px] px-2.5 py-1 tracking-wider transition-colors ${b.density === d ? 'text-black bg-primary font-bold' : 'text-primary/60 hover:text-primary'}`}>
                        {d.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              {/* Logo */}
              <section>
                <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2">Logo</div>
                <input value={b.logoUrl} onChange={(e) => set('logoUrl', e.target.value)}
                  placeholder="https://… — paste a link, or add one in MEDIA and copy it here"
                  className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-primary focus:outline-none focus:border-primary/50" />
                {b.logoUrl && /^https?:\/\//.test(b.logoUrl) && (
                  <div className="mt-2 h-16 bg-black/30 border border-primary/15 flex items-center justify-center">
                    <img src={b.logoUrl} alt="logo preview" className="max-h-full max-w-full object-contain" />
                  </div>
                )}
              </section>

              {/* Voice */}
              <section>
                <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2">Voice &amp; tone</div>
                <textarea value={b.voice} onChange={(e) => set('voice', e.target.value)} rows={3}
                  placeholder="e.g. warm and direct, no corporate jargon, short sentences, a bit of dry humour"
                  className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-primary focus:outline-none focus:border-primary/50" />
              </section>
            </div>

            <div className="p-3 border-t border-primary/20 shrink-0 flex items-center gap-2">
              <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-1.5 border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-[11px] disabled:opacity-40">
                {saving ? <Loader2 size={12} className="animate-spin" /> : saved ? <Check size={12} /> : <Palette size={12} />}
                {saved ? 'SAVED' : 'SAVE BRAND'}
              </button>
              <span className="text-[10px] text-ink/40">Written to <span className="font-mono">.morpheus/brand.json</span> in this project.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
