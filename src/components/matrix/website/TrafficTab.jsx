import { useState, useEffect, useCallback } from 'react';
import { Loader2, Send, RefreshCw, Check, AlertTriangle, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// TRAFFIC tab of the WEBSITE panel — the first workflow: tell IndexNow about a
// URL when it goes live or changes, and keep a record of what was submitted and
// what came back.
//
// The wording rules here are not decoration:
//   * IndexNow reports an HTTP status and nothing else. It does not tell us a URL
//     was indexed, so this tab never says "indexed" — it says "submitted" or
//     "accepted", which is what a 2xx actually means.
//   * 200 and 202 are different states (202 = key validation pending), and the
//     ledger shows the real code so they cannot be mistaken for each other.
//   * Everything in the plan that is NOT built is listed as not built. A tab that
//     silently omits the missing half reads as though the work is done.
const call = (projectId, action, data) =>
  base44.functions.invoke('trafficAction', { projectId, action, data }).then((r) => r.data);

const STATUS_TONE = (code) => {
  if (code === 200) return 'text-green-400';
  if (code === 202) return 'text-yellow-400';
  if (code === 0) return 'text-red-400';
  return code >= 400 ? 'text-red-400' : 'text-primary/60';
};

const when = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export default function TrafficTab({ projectId }) {
  const [status, setStatus] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(null); // 'toggle' | 'backfill' | 'reload'

  const load = useCallback(async () => {
    setErr(null);
    setBusy((b) => b || 'reload');
    try {
      const [s, l] = await Promise.all([
        call(projectId, 'status'),
        call(projectId, 'ledger'),
      ]);
      setStatus(s?.status || null);
      setLedger(l || null);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setBusy(null); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const toggle = async () => {
    const next = !status?.enabled;
    setBusy('toggle'); setErr(null); setNote(null);
    try {
      await call(projectId, 'settings', { enabled: next });
      setNote(next
        ? 'On. New and updated pages are submitted to IndexNow as they publish.'
        : 'Off. Nothing is submitted from this site.');
      await load();
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setBusy(null); }
  };

  const backfill = async () => {
    setBusy('backfill'); setErr(null); setNote(null);
    try {
      const r = await call(projectId, 'backfill');
      const res = r?.result || {};
      setNote(res.submitted
        ? `Submitted ${res.submitted} URL${res.submitted === 1 ? '' : 's'} in ${res.batches} batch${res.batches === 1 ? '' : 'es'}${res.ok ? '' : ' — some batches did not succeed, see the ledger'}.`
        : (res.note || 'Nothing needed submitting.'));
      await load();
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setBusy(null); }
  };

  const keyServed = status?.key_served;
  const notBuilt = status?.not_built || {};

  return (
    <div className="flex-1 overflow-y-auto scrollbar-matrix p-3 space-y-3 text-[11px]">
      <div className="flex items-center gap-2">
        <Send size={12} className="text-primary/70" />
        <span className="uppercase tracking-wider text-primary/80">Traffic</span>
        <button onClick={load} disabled={!!busy}
          className="ml-auto h-[28px] px-2 border border-primary/25 text-primary/70 hover:border-primary disabled:opacity-40 flex items-center gap-1">
          <RefreshCw size={10} className={busy === 'reload' ? 'animate-spin' : ''} /> Reload
        </button>
      </div>

      {err && (
        <div className="border border-red-500/30 text-red-400/90 px-2 py-1.5 flex items-start gap-1.5">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> <span>{err}</span>
        </div>
      )}
      {note && (
        <div className="border border-primary/25 text-ink-max px-2 py-1.5 flex items-start gap-1.5">
          <Check size={11} className="mt-0.5 shrink-0" /> <span>{note}</span>
        </div>
      )}
      {busy === 'reload' && !status && (
        <div className="text-ink-max flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Reading the site…</div>
      )}

      {status && (
        <>
          {/* The switch, and what it does in plain words. */}
          <div className="border border-primary/20 px-3 py-2 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-ink-max">Submit to IndexNow on publish</span>
              <button onClick={toggle} disabled={!!busy}
                className={`ml-auto h-[26px] px-3 border disabled:opacity-40 ${status.enabled
                  ? 'border-green-500/40 text-green-400 hover:border-green-400'
                  : 'border-primary/30 text-primary/70 hover:border-primary'}`}>
                {busy === 'toggle' ? <Loader2 size={10} className="animate-spin" /> : (status.enabled ? 'On' : 'Off')}
              </button>
            </div>
            <p className="text-ink-max leading-relaxed">
              When a page goes live, or a live one changes, the site tells IndexNow about the URL — which
              covers Bing and Yandex without an account. It cannot tell us a page was <em>indexed</em>; a
              2xx means the submission was accepted, and that is all this tab will claim.
            </p>
          </div>

          {/* The key: a submission is rejected when this is not being served. */}
          <div className="border border-primary/20 px-3 py-2 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-ink-max">Key file</span>
              <span className={`ml-auto ${keyServed?.served ? 'text-green-400' : 'text-yellow-400'}`}>
                {keyServed?.served ? 'being served' : 'NOT confirmed served'}
              </span>
            </div>
            <div className="font-mono text-[10px] text-ink-max break-all">{status.key_location}</div>
            {!keyServed?.served && (
              <p className="text-yellow-400/80 leading-relaxed">
                IndexNow authenticates the submission with this file. A check of that address did not
                return the key{keyServed?.status ? ` (HTTP ${keyServed.status})` : ''}, so submissions may
                come back 202 (&ldquo;key validation pending&rdquo;) or 403. Place the file by hand at the
                address above if the host does not run the rewrite:
              </p>
            )}
            {!keyServed?.served && (
              <div className="font-mono text-[10px] text-ink-max break-all bg-black/30 px-2 py-1">{status.key}</div>
            )}
          </div>

          {/* Counts: what we did, not what it achieved. */}
          <div className="flex items-center gap-3 text-ink-max">
            <span>{status.submitted || 0} submitted</span>
            <span className="text-green-400/80">{status.accepted || 0} accepted</span>
            <span className="ml-auto">last accepted {when(status.last_ok)}</span>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={backfill} disabled={!!busy || !status.enabled}
              title={status.enabled ? 'Submit the site\'s existing published URLs' : 'Turn the switch on first'}
              className="h-[30px] px-3 border border-primary/30 text-primary/80 hover:border-primary disabled:opacity-40 flex items-center gap-1.5">
              {busy === 'backfill' ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
              Submit existing pages
            </button>
            <span className="text-ink-max">up to {status.backfill_max} per run, skipping anything already accepted</span>
          </div>

          {/* The ledger — the reason this tab is allowed to make any claim at all. */}
          <div className="border border-primary/20">
            <div className="px-3 py-1.5 border-b border-primary/15 flex items-center gap-2 text-ink-max">
              <span>Submissions</span>
              {ledger?.summary && (
                <span className="text-ink-max">
                  {ledger.summary.accepted} accepted · {ledger.summary.failed} not{ledger.max ? ` · keeps last ${ledger.max}` : ''}
                </span>
              )}
            </div>
            {(!ledger?.rows || ledger.rows.length === 0) ? (
              <div className="px-3 py-2 text-ink-max">
                Nothing submitted yet. Publish a page, or submit the existing ones above.
              </div>
            ) : (
              <div className="max-h-[280px] overflow-y-auto divide-y divide-primary/10">
                {ledger.rows.map((row, i) => (
                  <div key={`${row.at}-${row.url}-${i}`} className="px-3 py-1.5 flex items-start gap-2">
                    <span className={`${STATUS_TONE(row.status)} shrink-0 w-[38px]`}>{row.status || '—'}</span>
                    <span className="text-ink-max shrink-0 w-[86px]">{when(row.at)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="text-ink-max break-all">{row.url}</span>
                      {row.note && <span className="text-ink-max"> — {row.note}</span>}
                    </span>
                    <span className="text-ink-max shrink-0">{row.action}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Not built. Named, not omitted — an absent half reads as a finished whole. */}
          <div className="border border-primary/15 px-3 py-2">
            <div className="text-ink-max mb-1 flex items-center gap-1.5">
              <X size={10} /> Not built yet
            </div>
            <ul className="space-y-0.5 text-ink-max">
              {Object.entries(notBuilt).map(([k, text]) => (
                <li key={k}>· {text}</li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
