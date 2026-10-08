import { useState, useEffect, useCallback } from 'react';
import { Loader2, RefreshCw, Check, Trash2, X, CornerDownRight } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// REDIRECTS + the 404 log.
//
// Two halves of one job: the rule list is what you decide, and the 404 log is what
// tells you which rule to write. The log is the reason this exists at all — on a shop
// the URLs that break are the ones someone already linked to, and until now a 404 was
// invisible from inside Morpheus.
//
// THREE THINGS THE WORDING HAS TO GET RIGHT, and they are not decoration:
//   * a 410 is NOT a redirect. It says "this is gone", and the plugin answers it with
//     that status rather than a Location header. The panel must not call it one.
//   * the protected paths are stated BEFORE a rule is refused, because "why can't I
//     redirect /wp-admin?" is a fair question and the answer is "you would lock
//     yourself out".
//   * the 404 counts are FLOORS under a flood — the plugin throttles its writes — so
//     the panel says "at least", exactly as the traffic tab refuses to say "indexed".

const call = (projectId, action, data, id, confirm) =>
  base44.functions.invoke('wordPressRedirects', { projectId, action, data, id, confirm }).then((r) => r.data);

const STATUS_WORD = { 301: 'permanent', 302: 'temporary', 307: 'temporary', 410: 'gone' };

const when = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const btn = 'inline-flex items-center justify-center gap-1.5 px-3 h-[26px] border border-primary/30 text-[10px] uppercase tracking-wider text-primary/80 hover:text-primary hover:border-primary disabled:opacity-40 shrink-0';
const field = 'w-full bg-black/30 border border-primary/20 px-2 h-[30px] text-[12px] text-ink-strong outline-none focus:border-primary/50';

const EMPTY = { id: '', from: '', to: '', status: 301 };

export default function RedirectsPanel({ projectId }) {
  const [state, setState] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [log, setLog] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setBusy('load'); setErr(null);
    try {
      const out = await call(projectId, 'status');
      if (out && out.ok === false) { setErr(out.message || out.error || 'The site refused to report its redirects.'); return; }
      setState(out);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setBusy(null); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const run = async (action, data, id, confirm) => {
    setBusy(action); setErr(null); setNote(null);
    try {
      const out = await call(projectId, action, data, id, confirm);
      // ⚠️ A REFUSAL IS THE SITE'S ANSWER, NOT A TRANSPORT FAILURE. The plugin refuses
      // a rule with `{ ok:false, error, message }` and a 4xx, and the server passes it
      // straight through — so `call()` RESOLVES. The first version of this panel only
      // rendered a THROWN error, which meant the lockout refusal ("that path could lock
      // you out of your own site") vanished and pressing SAVE looked like pressing
      // nothing. Caught by driving it in a browser; no source check would have seen it.
      if (out && out.ok === false) {
        setErr(out.message || out.error || 'The site refused that.');
        return null;
      }
      if (out.rules) setState((s) => ({ ...(s || {}), rules: out.rules }));
      return out;
    } catch (e) { setErr(e?.data?.error || e.message); return null; }
    finally { setBusy(null); }
  };

  const save = async () => {
    const out = form.id
      ? await run('update', { from: form.from, to: form.to, status: Number(form.status) }, form.id)
      : await run('create', { from: form.from, to: form.to, status: Number(form.status) });
    if (out) {
      setForm(EMPTY);
      setNote(out.rule ? `Saved: ${out.rule.from} → ${out.rule.to || 'Gone (410)'}` : null);
      load();
    }
  };

  const toggle = async () => {
    const out = await run('settings', { enabled: !state?.enabled });
    if (out) setState((s) => ({ ...s, enabled: out.enabled }));
  };

  const loadLog = async () => {
    setBusy('log'); setErr(null); setNote(null);
    try {
      const out = await call(projectId, 'log');
      // Same rule as `run` above: a refusal resolves, so it has to be looked at.
      if (out && out.ok === false) { setErr(out.message || out.error || 'The site refused to read its 404 log.'); return; }
      setLog(out);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setBusy(null); }
  };

  const clearLog = async () => {
    const out = await run('clear_log', {}, '', true);
    setConfirmClear(false);
    if (out) { setLog(null); setNote(`Cleared ${out.cleared} missing-page record${out.cleared === 1 ? '' : 's'}.`); }
  };

  const remove = async (id) => {
    const out = await run('delete', {}, id, true);
    setPendingDelete(null);
    if (out) load();
  };

  const rules = state?.rules || [];

  return (
    <div className="space-y-3 text-[11px]">
      <p className="text-ink-max leading-relaxed">
        Where a URL that no longer exists should send people, and — below it — which addresses are actually
        being asked for and not found. Every WooCommerce store retires products and renames categories; those
        URLs stay in bookmarks, in search results and in other people&apos;s links.
      </p>

      {err && <div className="text-red-400 border border-red-500/30 px-3 py-2 break-words">{err}</div>}
      {note && <div className="text-green-400/90 border border-green-500/30 px-3 py-2">{note}</div>}

      {busy === 'load' && !state && (
        <div className="text-ink-max flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Reading the site…</div>
      )}

      {state && (
        <>
          <div className="border border-primary/20 px-3 py-2 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-ink-max">Apply redirects on this site</span>
              <button onClick={toggle} disabled={!!busy}
                className={`ml-auto h-[26px] px-3 border disabled:opacity-40 ${state.enabled
                  ? 'border-green-500/40 text-green-400 hover:border-green-400'
                  : 'border-primary/30 text-primary/70 hover:border-primary'}`}>
                {busy === 'settings' ? <Loader2 size={10} className="animate-spin" /> : (state.enabled ? 'On' : 'Off')}
              </button>
            </div>
            <p className="text-ink-max leading-relaxed">
              Switching this off leaves the rules and the log exactly as they are — it only stops them being
              applied. <span className="text-ink-max">{(state.protected || []).slice(0, 3).join(', ')}</span> and the rest of
              the WordPress admin are never redirectable, whatever the rules say: a rule there could lock you
              out of the screen you would fix it on.
            </p>
          </div>

          {/* The form. One place, used for both adding and editing. */}
          <div className="border border-primary/20 px-3 py-2 space-y-2">
            <div className="text-primary/40 uppercase tracking-wider">{form.id ? 'Edit redirect' : 'Add a redirect'}</div>
            <div className="grid grid-cols-2 gap-2">
              <input className={field} placeholder="/old-url" value={form.from}
                onChange={(e) => setForm({ ...form, from: e.target.value })} />
              <input className={field} placeholder="/new-url or https://…" value={form.to}
                disabled={Number(form.status) === 410}
                onChange={(e) => setForm({ ...form, to: e.target.value })} />
            </div>
            <div className="flex items-center gap-2">
              <select className={`${field} w-auto`} value={form.status}
                onChange={(e) => setForm({ ...form, status: Number(e.target.value), to: Number(e.target.value) === 410 ? '' : form.to })}>
                <option value={301}>301 — moved permanently</option>
                <option value={302}>302 — temporary</option>
                <option value={307}>307 — temporary, method kept</option>
                <option value={410}>410 — gone (no destination)</option>
              </select>
              <button className={btn} onClick={save} disabled={!!busy || !form.from || (Number(form.status) !== 410 && !form.to)}>
                {busy === 'create' || busy === 'update' ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} SAVE
              </button>
              {form.id ? (
                <button className={btn} onClick={() => setForm(EMPTY)} disabled={!!busy}><X size={11} /> CANCEL</button>
              ) : null}
            </div>
            <p className="text-ink-max">
              A <span className="text-ink-max">410</span> is not a redirect: it tells search engines the page is
              finished, which is the honest answer for a product that is never coming back.
            </p>
          </div>

          {/* The rules. */}
          {rules.length === 0 ? (
            <div className="text-ink-max border border-primary/15 px-3 py-2">No redirects yet.</div>
          ) : (
            <div className="space-y-1">
              {rules.map((r) => (
                <div key={r.id} className="border border-primary/15 px-2.5 py-2 space-y-1">
                  <div className="flex items-start gap-2">
                    <span className={`shrink-0 border px-1.5 py-0.5 uppercase tracking-wider ${Number(r.status) === 410 ? 'text-yellow-500/90 border-yellow-500/40' : 'text-primary/70 border-primary/30'}`}>
                      {r.status}
                    </span>
                    <span className="min-w-0 flex-1 font-mono break-all">{r.from}</span>
                    <CornerDownRight size={12} className="shrink-0 text-primary/40 mt-0.5" />
                    <span className="min-w-0 flex-1 font-mono break-all">{r.to || '— gone —'}</span>
                  </div>
                  <div className="flex items-center gap-2 text-ink-max">
                    <span>{STATUS_WORD[r.status] || ''}</span>
                    <span className="ml-auto">{r.hits ? `${r.hits} served` : 'not used yet'}</span>
                    <button className={btn} onClick={() => setForm({ id: r.id, from: r.from, to: r.to, status: Number(r.status) })} disabled={!!busy}>EDIT</button>
                    {pendingDelete === r.id ? (
                      <>
                        <button className={`${btn} border-red-500/40 text-red-300/90`} onClick={() => remove(r.id)} disabled={!!busy}>
                          {busy === 'delete' ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />} REALLY DELETE
                        </button>
                        <button className={btn} onClick={() => setPendingDelete(null)} disabled={!!busy}>KEEP</button>
                      </>
                    ) : (
                      <button className={btn} onClick={() => setPendingDelete(r.id)} disabled={!!busy}><Trash2 size={11} /> DELETE</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* The 404 log — the half that tells you what to do next. */}
          <div className="border border-primary/20 px-3 py-2 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-ink-max">Addresses being asked for and not found</span>
              <button className={`${btn} ml-auto`} onClick={loadLog} disabled={!!busy}>
                {busy === 'log' ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} {log ? 'REFRESH' : 'LOOK'}
              </button>
            </div>

            {!log && !busy ? (
              <p className="text-ink-max leading-relaxed">
                Morpheus records a 404 when one happens, grouped by address. Looking here changes nothing on the
                site and reads a log on it.
              </p>
            ) : null}

            {log ? (
              log.rows.length === 0 ? (
                <p className="text-ink-max flex items-center gap-1.5"><Check size={12} className="text-primary" /> Nothing missing has been recorded.</p>
              ) : (
                <>
                  <div className="text-ink-max">
                    At least {log.total} miss{log.total === 1 ? '' : 'es'} recorded, {log.rows.length} distinct
                    {' '}address{log.rows.length === 1 ? '' : 'es'} — counted by the site, so the busiest are the ones
                    costing you visitors.
                  </div>
                  <div className="space-y-1">
                    {log.rows.map((row) => (
                      <div key={row.path} className="border border-primary/15 px-2.5 py-1.5 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 font-mono break-all">{row.path}</span>
                          <span className="shrink-0 text-ink-max">{row.hits}×</span>
                          <button className={btn} disabled={!!busy}
                            onClick={() => setForm({ id: '', from: row.path, to: '', status: 301 })}>
                            REDIRECT THIS
                          </button>
                        </div>
                        <div className="text-ink-max">
                          last {when(row.last_at)}
                          {row.referrer ? <> · linked from <span className="font-mono break-all">{row.referrer}</span></> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                  {log.rows.length >= log.max ? (
                    <p className="text-ink-max">
                      The log holds {log.max}, and it is full. When a new address arrives the LEAST-HIT one is
                      dropped, so a scanner asking for thousands of addresses cannot push out a link your
                      visitors are actually hitting. Entries older than {log.days} days are dropped too.
                    </p>
                  ) : null}

                  {confirmClear ? (
                    <div className="border border-yellow-500/30 px-3 py-2 space-y-2">
                      <div className="text-ink-max leading-relaxed">
                        Clear the missing-page log? The rule list is untouched, and the site keeps recording new
                        404s from that moment — but what was recorded until now is gone.
                      </div>
                      <div className="flex items-center gap-2">
                        <button className={`${btn} border-yellow-500/40 text-yellow-500/90`} onClick={clearLog} disabled={!!busy}>
                          {busy === 'clear_log' ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />} CLEAR IT
                        </button>
                        <button className={btn} onClick={() => setConfirmClear(false)} disabled={!!busy}>KEEP IT</button>
                      </div>
                    </div>
                  ) : (
                    <button className={btn} onClick={() => setConfirmClear(true)} disabled={!!busy}>
                      <Trash2 size={11} /> CLEAR THE LOG
                    </button>
                  )}
                </>
              )
            ) : null}
          </div>

          {state.rules_max ? (
            <p className="text-ink-max">
              Up to {state.rules_max} rules on a site. Every one that fires is counted, so a rule with no
              {' '}<span className="text-ink-max">served</span> count is one that nothing is reaching.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
