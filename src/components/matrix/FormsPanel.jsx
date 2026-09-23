import { useState, useEffect, useCallback } from 'react';
import { X, Inbox, Loader2, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Forms delivery (2026-09-09) — where this site's <form> submissions go.
// Stored as .morpheus/forms.json in the project (travels with export / repo).
// ZERO CUSTODY: no submission ever touches Morpheus. The generated handler
// runs on the operator's host and delivers to the operator's own inbox/sheet.
// This panel just sets the destination + method so every <form> the builder
// makes is wired up, not decorative.

const METHOD_LABELS = {
  netlify: ['Netlify Forms', 'No server code. Netlify catches submissions from any form on a site it hosts.'],
  smtp: ['Email (SMTP)', 'A serverless function emails each submission to you. Works on any host. Needs SMTP env vars (a free Gmail app password works).'],
  sheet: ['Google Sheet', 'A serverless function appends each submission as a row in your Google Sheet via an Apps Script web app.'],
};

export default function FormsPanel({ open, onClose, projectId, onSetChange }) {
  const [state, setState] = useState(null); // { forms, methods, setup, isWeb }
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const { data } = await base44.functions.invoke('getProjectForms', { projectId });
      setState(data);
      setDraft(JSON.parse(JSON.stringify(data.forms)));
    } catch (e) {
      setErr(e?.data?.error || e.message);
    }
  }, [projectId]);

  useEffect(() => { if (open) { setSaved(false); setErr(null); load(); } }, [open, load]);

  if (!open) return null;

  const set = (key, value) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const { data } = await base44.functions.invoke('saveProjectForms', { projectId, forms: draft });
      setState((s) => ({ ...s, forms: data.forms }));
      setDraft(JSON.parse(JSON.stringify(data.forms)));
      setSaved(true);
      onSetChange?.(data.forms.enabled);
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  };

  const f = draft;
  const methods = state?.methods || ['netlify', 'smtp', 'sheet'];
  const setup = (state?.setup || {})[f?.method] || [];
  const emailValid = !f?.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim());

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div className="bg-background border-l border-primary/40 w-full max-w-md h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <Inbox size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">FORMS</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <p className="text-[11px] text-ink/45 leading-relaxed px-4 py-2 border-b border-primary/10">
          Where contact / signup form submissions land. Morpheus never receives them — the builder generates a handler
          that runs on your host and delivers to <span className="text-ink/70">your</span> inbox or sheet.
          {state && state.isWeb === false && <span className="text-yellow-500/80"> This project isn't a web-app target, so this won't be applied.</span>}
        </p>

        {!f && <div className="p-4 flex items-center gap-2 text-ink/60 text-xs"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
        {err && <div className="m-4 text-red-400 text-xs border border-red-500/30 px-3 py-2">{err}</div>}

        {f && (
          <>
            <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-5">
              {/* Enable */}
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)}
                  className="accent-[color:var(--primary,#4f8cff)] w-4 h-4" />
                <div>
                  <div className="text-[12px] text-ink/85">Wire up forms on this site</div>
                  <div className="text-[10px] text-ink/40">When on, every &lt;form&gt; the builder adds gets a real, delivering handler.</div>
                </div>
              </label>

              {f.enabled && (
                <>
                  {/* Destination email */}
                  <section>
                    <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2">Send submissions to</div>
                    <input value={f.email} onChange={(e) => set('email', e.target.value)} type="email"
                      placeholder="you@yourdomain.com"
                      className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-primary focus:outline-none focus:border-primary/50" />
                    {!emailValid && <div className="text-[10px] text-red-400/80 mt-1">That doesn't look like an email address.</div>}
                    <div className="text-[10px] text-ink/40 mt-1">Your own address. Leave blank to set it later — the form still gets built.</div>
                  </section>

                  {/* Method */}
                  <section>
                    <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2">Delivery method</div>
                    <div className="space-y-2">
                      {methods.map((m) => {
                        const [label, hint] = METHOD_LABELS[m] || [m, ''];
                        return (
                          <label key={m} className={`flex gap-3 border px-3 py-2 cursor-pointer transition-colors ${f.method === m ? 'border-primary/60 bg-primary/5' : 'border-primary/15 hover:border-primary/30'}`}>
                            <input type="radio" name="forms-method" checked={f.method === m} onChange={() => set('method', m)}
                              className="accent-[color:var(--primary,#4f8cff)] mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              <div className="text-[11px] text-ink/80">{label}</div>
                              <div className="text-[10px] text-ink/40 leading-snug">{hint}</div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </section>

                  {/* Thank-you path */}
                  <section>
                    <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2">After submit, go to</div>
                    <input value={f.thankYouPath} onChange={(e) => set('thankYouPath', e.target.value)}
                      placeholder="/thank-you"
                      className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-primary font-mono focus:outline-none focus:border-primary/50" />
                    <div className="text-[10px] text-ink/40 mt-1">A page path on this site. The builder creates it if it doesn't exist.</div>
                  </section>

                  {/* Setup steps */}
                  {setup.length > 0 && (
                    <section className="border border-primary/15 bg-black/20 p-3">
                      <div className="text-[11px] text-primary/60 tracking-widest uppercase mb-2">Your setup — {(METHOD_LABELS[f.method] || [f.method])[0]}</div>
                      <ol className="space-y-1.5 list-decimal list-inside">
                        {setup.map((s, i) => (
                          <li key={i} className="text-[10px] text-primary/55 leading-relaxed">{s}</li>
                        ))}
                      </ol>
                    </section>
                  )}
                </>
              )}
            </div>

            <div className="p-3 border-t border-primary/20 shrink-0 flex items-center gap-2">
              <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-1.5 border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-[11px] disabled:opacity-40">
                {saving ? <Loader2 size={12} className="animate-spin" /> : saved ? <Check size={12} /> : <Inbox size={12} />}
                {saved ? 'SAVED' : 'SAVE FORMS'}
              </button>
              <span className="text-[10px] text-ink/40">Written to <span className="font-mono">.morpheus/forms.json</span> in this project.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
