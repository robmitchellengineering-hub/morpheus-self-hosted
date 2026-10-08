import { useState, useEffect, useCallback } from 'react';
import { Loader2, RefreshCw, Check, AlertTriangle, Clock } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// UPTIME — whether the site has been answering, and when it stopped.
//
// WHY THIS EXISTS. /status answers in every build of the plugin, needs no signature and
// costs one HTTP request, and nothing stored the answer — so "was my site up last
// night?" had no answer anywhere. A site that was down for an hour while its owner
// slept looked exactly like one that had never been checked.
//
// THE WORDING IS THE FEATURE, and every line of it is decided by what the server can
// actually know:
//   * a window with no checks shows "—", NEVER 0% and never 100%. "We did not look" is
//     not "it was down", and a site nobody has checked must not read as broken.
//   * `stale` is shown, not hidden: an "up" from forty minutes ago is a claim about
//     forty minutes ago, and a monitor that quietly stopped must not read as fine.
//   * an outage still happening is shown as running, with no end — it is the one an
//     owner most needs to see now rather than after it recovers.
//   * the plugin version is the last one the site REPORTED, so a site that is down
//     right now still says what it was running before it went.
//
// It checks on open ONLY when what it has is stale or absent — one request, and the
// alternative is a panel that shows last week's answer under the heading "uptime".

const call = (projectId, action) =>
  base44.functions.invoke('siteUptime', { projectId, action }).then((r) => r.data);

const btn = 'inline-flex items-center justify-center gap-1.5 px-3 h-[26px] border border-primary/30 text-[10px] uppercase tracking-wider text-primary/80 hover:text-primary hover:border-primary disabled:opacity-40 shrink-0';

const when = (iso) => {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const dur = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};

const pct = (v) => (v == null ? '—' : `${v}%`);

export default function UptimePanel({ projectId }) {
  const [state, setState] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);

  const run = useCallback(async (action) => {
    if (!projectId) return null;
    setBusy(action); setErr(null);
    try {
      const out = await call(projectId, action);
      if (out && out.ok === false) { setErr(out.message || out.error || 'The site refused the check.'); return null; }
      setState(out);
      return out;
    } catch (e) { setErr(e?.data?.error || e.message); return null; }
    finally { setBusy(null); }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const first = await run('status');
      if (cancelled || !first) return;
      // Only when there is nothing to show, or what we have is old. An uptime panel
      // that never refreshes itself is a screenshot, not a monitor.
      if (first.ready && (first.state === 'unknown' || first.stale)) await run('check');
    })();
    return () => { cancelled = true; };
  }, [run]);

  const tone = state?.state === 'up' ? 'text-green-400' : state?.state === 'down' ? 'text-red-400' : 'text-yellow-500/90';

  return (
    <div className="space-y-3 text-[11px]">
      <p className="text-ink-max leading-relaxed">
        Morpheus asks the site a question every few minutes and records the answer — one request, no
        password, and it works even on a site running an old build of the plugin.
      </p>

      {err && <div className="text-red-400 border border-red-500/30 px-3 py-2 break-words">{err}</div>}
      {busy === 'status' && !state ? (
        <div className="text-ink-max flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Checking…</div>
      ) : null}

      {state ? (
        <>
          {!state.ready ? (
            <div className="border border-yellow-500/30 px-3 py-2 text-ink-max leading-relaxed">
              Uptime history is not set up on this Morpheus server yet — the table it needs has not been added
              to the database. Checking still works; nothing is being kept yet.
            </div>
          ) : null}

          <div className="border border-primary/20 px-3 py-2 space-y-1">
            <div className="flex items-center gap-2">
              <span className={`uppercase tracking-wider ${tone}`}>
                {state.state === 'up' ? 'Answering' : state.state === 'down' ? 'Not answering' : 'Never checked'}
              </span>
              {state.stale && state.state !== 'unknown' ? (
                <span className="text-yellow-500/90 flex items-center gap-1"><Clock size={10} /> this reading is old</span>
              ) : null}
              <button className={`${btn} ml-auto`} onClick={() => run('check')} disabled={!!busy}>
                {busy === 'check' ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} CHECK NOW
              </button>
            </div>
            <div className="text-ink-max">
              last checked {when(state.last_checked_at)}
              {state.checks ? <> · {state.checks} check{state.checks === 1 ? '' : 's'} kept</> : null}
              {state.plugin_version ? <> · plugin {state.plugin_version}</> : null}
              {state.avg_latency_ms ? <> · {state.avg_latency_ms}ms average</> : null}
            </div>
            {state.just_checked && state.just_checked.ok === false ? (
              <div className="text-red-400">
                The check just now did not get an answer{state.just_checked.status_code ? ` (HTTP ${state.just_checked.status_code})` : ''}
                {state.just_checked.error ? `: ${state.just_checked.error}` : '.'}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-3 text-ink-max">
            {['1d', '7d', '30d'].map((w) => (
              <span key={w}>
                <span className="text-primary/60 uppercase tracking-wider">{w}</span>{' '}
                <span className="text-ink-max">{pct(state.uptime?.[w])}</span>
              </span>
            ))}
            <span className="ml-auto text-ink-max">
              {state.uptime?.['1d'] == null ? 'no checks in the window yet — not the same as 0%' : 'share of checks that answered'}
            </span>
          </div>

          <div className="space-y-1">
            <div className="text-primary/40 uppercase tracking-wider">Outages</div>
            {state.incidents?.length ? (
              state.incidents.map((i, n) => (
                <div key={n} className="border border-primary/15 px-2.5 py-1.5">
                  <div className="flex items-start gap-2">
                    {i.ended_at ? <Check size={12} className="text-primary mt-0.5 shrink-0" /> : <AlertTriangle size={12} className="text-red-400 mt-0.5 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      {when(i.started_at)} → {i.ended_at ? when(i.ended_at) : 'still down'}
                      <span className="text-ink-max"> · {dur(i.duration_ms)} · {i.checks} failed check{i.checks === 1 ? '' : 's'}</span>
                    </span>
                  </div>
                  {i.error ? <div className="text-ink-max break-words">{i.status_code ? `HTTP ${i.status_code} · ` : ''}{i.error}</div> : null}
                </div>
              ))
            ) : (
              <div className="text-ink-max">
                {state.checks ? 'No outage has been recorded in the checks that are kept.' : 'Nothing recorded yet — this fills in as Morpheus checks the site.'}
              </div>
            )}
          </div>

          <p className="text-ink-max leading-relaxed">
            Checks run every few minutes while this Morpheus server&apos;s background worker is running, and
            whenever you press CHECK NOW. History is kept for {state.retain_days} days.
          </p>
        </>
      ) : null}
    </div>
  );
}
