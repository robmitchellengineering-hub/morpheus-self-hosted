import { useState, useEffect, useCallback } from 'react';
import { X, Globe, Loader2, Check, Copy, Activity, ShieldCheck, ShieldAlert, History, RotateCcw, BarChart3 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Domain connection + live-site status (2026-09-09). The site lives on the
// operator's own host, served from their own repo — Morpheus stores only
// the domain string (.morpheus/site.json). This panel: set the domain +
// host, get the exact DNS records to add, and run an on-demand live check
// (DNS / HTTPS / TLS cert / redirect). Continuous uptime monitoring is a
// separate feature (a scheduled GitHub Action in the operator's repo).
//
// Rollback: the connected repo IS the deploy history (the host redeploys on
// push). "Roll back" lands one forward commit restoring every file to the
// chosen state — no force-push, no history rewrite.

const HOST_LABELS = {
  netlify: 'Netlify',
  vercel: 'Vercel',
  'cloudflare-pages': 'Cloudflare Pages',
  'github-pages': 'GitHub Pages',
  other: 'Other / my own server',
};

function relTime(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

const A_FIELD_META = {
  token: ['Beacon token', 'from Cloudflare → Web Analytics → your site'],
  code: ['Site code', 'your GoatCounter subdomain, e.g. valiantmusic'],
  domain: ['data-domain', 'e.g. valiantmusic.com.au'],
  src: ['Script URL', 'https://your-instance/js/script.js'],
  websiteId: ['Website ID', 'the UUID from your Umami dashboard'],
};

function CopyBtn({ text }) {
  const [hit, setHit] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard?.writeText(text); setHit(true); setTimeout(() => setHit(false), 1200); }}
      className="text-primary/40 hover:text-primary shrink-0"
      title="Copy"
    >
      {hit ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function StatusRow({ label, ok, children }) {
  const Icon = ok == null ? Activity : ok ? ShieldCheck : ShieldAlert;
  const color = ok == null ? 'text-primary/50' : ok ? 'text-green-400/90' : 'text-red-400/90';
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <Icon size={13} className={`${color} mt-0.5 shrink-0`} />
      <div className="min-w-0">
        <span className="text-primary/70">{label}</span>
        <div className={`${color} leading-snug`}>{children}</div>
      </div>
    </div>
  );
}

export default function DomainPanel({ open, onClose, projectId, onSetChange }) {
  const [state, setState] = useState(null); // { site, hosts, dnsRecords, tlsNote, githubRepo, isWeb }
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState(null);
  const [checkErr, setCheckErr] = useState(null);
  const [history, setHistory] = useState(null); // { connected, commits, branch, headSha, repo }
  const [historyErr, setHistoryErr] = useState(null);
  const [rollingBack, setRollingBack] = useState(null); // sha being rolled back to
  const [rollbackDone, setRollbackDone] = useState(null); // { commitSha, rolledBackToSha }
  const [monitorInterval, setMonitorInterval] = useState(15);
  const [monitorBusy, setMonitorBusy] = useState(null); // 'set' | 'off'
  const [monitorErr, setMonitorErr] = useState(null);
  const [analytics, setAnalytics] = useState(null); // { analytics, providers, snippet, isWeb }
  const [aDraft, setADraft] = useState(null);
  const [aBusy, setABusy] = useState(false);
  const [aSaved, setASaved] = useState(false);
  const [aErr, setAErr] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const { data } = await base44.functions.invoke('getProjectSite', { projectId });
      setState(data);
      setDraft(JSON.parse(JSON.stringify(data.site)));
    } catch (e) {
      setErr(e?.data?.error || e.message);
    }
    try {
      const { data } = await base44.functions.invoke('getSiteHistory', { projectId });
      setHistory(data);
    } catch (e) {
      setHistoryErr(e?.data?.error || e.message);
    }
    try {
      const { data } = await base44.functions.invoke('getProjectAnalytics', { projectId });
      setAnalytics(data);
      setADraft(JSON.parse(JSON.stringify(data.analytics)));
    } catch (e) {
      setAErr(e?.data?.error || e.message);
    }
  }, [projectId]);

  useEffect(() => { if (open) { setSaved(false); setErr(null); setStatus(null); setCheckErr(null); setHistoryErr(null); setRollbackDone(null); setMonitorErr(null); setAErr(null); setASaved(false); load(); } }, [open, load]);

  useEffect(() => {
    if (history?.monitoring?.active && history.monitoring.intervalMinutes) setMonitorInterval(history.monitoring.intervalMinutes);
  }, [history?.monitoring?.active, history?.monitoring?.intervalMinutes]);

  if (!open) return null;

  const set = (key, value) => { setDraft((d) => ({ ...d, [key]: value })); setSaved(false); };

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const { data } = await base44.functions.invoke('saveProjectSite', { projectId, site: draft });
      setState((s) => ({ ...s, site: data.site, dnsRecords: data.dnsRecords, tlsNote: data.tlsNote }));
      setDraft(JSON.parse(JSON.stringify(data.site)));
      setSaved(true);
      onSetChange?.(!!data.site.domain);
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    setChecking(true); setCheckErr(null); setStatus(null);
    try {
      const { data } = await base44.functions.invoke('checkSiteStatus', { projectId });
      setStatus(data);
    } catch (e) {
      setCheckErr(e?.data?.error || e.message);
    } finally {
      setChecking(false);
    }
  };

  const rollback = async (sha) => {
    if (!window.confirm(`Roll the live site back to ${sha.slice(0, 7)}?\n\nThis lands one new commit on ${history?.branch || 'the branch'} that restores every file to that state. Your host will redeploy. Nothing is force-pushed or rewritten.`)) return;
    setRollingBack(sha); setHistoryErr(null); setRollbackDone(null);
    try {
      const { data } = await base44.functions.invoke('rollbackSite', { projectId, targetSha: sha, confirm: true });
      setRollbackDone(data);
      const { data: h } = await base44.functions.invoke('getSiteHistory', { projectId });
      setHistory(h);
    } catch (e) {
      setHistoryErr(e?.data?.error || e.message);
    } finally {
      setRollingBack(null);
    }
  };

  const refreshHistory = async () => {
    try { const { data } = await base44.functions.invoke('getSiteHistory', { projectId }); setHistory(data); } catch { /* */ }
  };

  const setupMonitor = async (minutes) => {
    setMonitorBusy('set'); setMonitorErr(null);
    try {
      await base44.functions.invoke('setupUptimeMonitor', { projectId, intervalMinutes: minutes });
      await refreshHistory();
    } catch (e) {
      setMonitorErr(e?.data?.error || e.message);
    } finally {
      setMonitorBusy(null);
    }
  };

  const removeMonitor = async () => {
    if (!window.confirm('Turn off uptime monitoring? This deletes the workflow file from your repo.')) return;
    setMonitorBusy('off'); setMonitorErr(null);
    try {
      await base44.functions.invoke('removeUptimeMonitor', { projectId, confirm: true });
      await refreshHistory();
    } catch (e) {
      setMonitorErr(e?.data?.error || e.message);
    } finally {
      setMonitorBusy(null);
    }
  };

  const setA = (key, value) => { setADraft((a) => ({ ...a, [key]: value })); setASaved(false); };
  const setAProvider = (provider) => { setADraft({ provider }); setASaved(false); };

  const saveAnalytics = async () => {
    setABusy(true); setAErr(null);
    try {
      const { data } = await base44.functions.invoke('saveProjectAnalytics', { projectId, analytics: aDraft });
      setAnalytics((s) => ({ ...s, analytics: data.analytics, snippet: data.snippet }));
      setADraft(JSON.parse(JSON.stringify(data.analytics)));
      setASaved(true);
    } catch (e) {
      setAErr(e?.data?.error || e.message);
    } finally {
      setABusy(false);
    }
  };

  const d = draft;
  const hosts = state?.hosts || Object.keys(HOST_LABELS);
  const records = state?.dnsRecords || [];
  const savedDomain = state?.site?.domain;
  const dirty = d && state && JSON.stringify(d) !== JSON.stringify(state.site);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div className="bg-background border-l border-primary/40 w-full max-w-md h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">DOMAIN</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <p className="text-[11px] text-ink/45 leading-relaxed px-4 py-2 border-b border-primary/10">
          Your production domain and where it's hosted. The builder uses it for canonical / Open Graph / sitemap URLs.
          Morpheus stores only the domain — your site stays on your host, served from your repo.
          {state && state.isWeb === false && <span className="text-yellow-500/80"> This project isn't a web-app target.</span>}
        </p>

        {!d && <div className="p-4 flex items-center gap-2 text-primary/60 text-xs"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
        {err && <div className="m-4 text-red-400 text-xs border border-red-500/30 px-3 py-2">{err}</div>}

        {d && (
          <>
            <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-5">
              {/* Domain */}
              <section>
                <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2">Domain</div>
                <input value={d.domain} onChange={(e) => set('domain', e.target.value)}
                  placeholder="valiantmusic.com.au"
                  className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-primary font-mono focus:outline-none focus:border-primary/50" />
                <div className="text-[10px] text-ink/40 mt-1">Registrable domain, no https:// and no www — the www / apex choice is below.</div>
              </section>

              {/* Host */}
              <section>
                <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2">Hosted on</div>
                <select value={d.host} onChange={(e) => set('host', e.target.value)}
                  className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-primary focus:outline-none focus:border-primary/50">
                  <option value="">— choose —</option>
                  {hosts.map((h) => <option key={h} value={h}>{HOST_LABELS[h] || h}</option>)}
                </select>
                {d.host && d.host !== 'other' && (
                  <input value={d.hostSubdomain} onChange={(e) => set('hostSubdomain', e.target.value)}
                    placeholder={`your host subdomain (e.g. my-site.${d.host === 'github-pages' ? 'github.io' : d.host === 'vercel' ? 'vercel.app' : d.host === 'cloudflare-pages' ? 'pages.dev' : 'netlify.app'})`}
                    className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-primary font-mono focus:outline-none focus:border-primary/50 mt-2" />
                )}
              </section>

              {/* Canonical */}
              <section>
                <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2">Canonical hostname</div>
                <div className="flex border border-primary/30 w-max">
                  {[['apex', d.domain || 'example.com'], ['www', `www.${d.domain || 'example.com'}`]].map(([v, lbl]) => (
                    <button key={v} onClick={() => set('canonical', v)}
                      className={`text-[10px] px-2.5 py-1 font-mono transition-colors ${d.canonical === v ? 'text-black bg-primary font-bold' : 'text-primary/60 hover:text-primary'}`}>
                      {lbl}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-ink/40 mt-1">The other one 301-redirects here.</div>
              </section>

              {/* DNS records */}
              {records.length > 0 && !dirty && (
                <section>
                  <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2">DNS records to add</div>
                  <div className="border border-primary/15">
                    {records.map((r, i) => (
                      <div key={i} className="px-2 py-1.5 border-b border-primary/10 last:border-0">
                        <div className="flex items-center gap-2 font-mono text-[10px] text-primary/80">
                          <span className="text-primary/50 w-12 shrink-0">{r.type}</span>
                          <span className="w-8 shrink-0">{r.name}</span>
                          <span className="flex-1 min-w-0 break-all">{r.value}</span>
                          <CopyBtn text={r.value} />
                        </div>
                        {r.note && <div className="text-[9px] text-ink/35 mt-0.5 pl-14">{r.note}</div>}
                      </div>
                    ))}
                  </div>
                  {state.tlsNote && <div className="text-[10px] text-ink/45 mt-1.5 leading-snug">{state.tlsNote}</div>}
                </section>
              )}
              {dirty && <div className="text-[10px] text-yellow-500/70">Save to refresh the DNS records for this host.</div>}

              {/* Live check */}
              {savedDomain && !dirty && (
                <section className="border border-primary/15 bg-black/20 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[11px] text-primary/60 tracking-widest uppercase">Live status</div>
                    <button onClick={runCheck} disabled={checking}
                      className="flex items-center gap-1 px-2 py-1 border border-primary/40 text-primary/80 hover:border-primary hover:text-primary text-[10px] disabled:opacity-40">
                      {checking ? <Loader2 size={11} className="animate-spin" /> : <Activity size={11} />} CHECK NOW
                    </button>
                  </div>
                  {checkErr && <div className="text-red-400 text-[10px] border border-red-500/30 px-2 py-1">{checkErr}</div>}
                  {status && (
                    <div className="space-y-2">
                      <div className={`text-[11px] font-bold ${status.live ? 'text-green-400' : 'text-red-400'}`}>
                        {status.live ? `● LIVE — ${status.canonicalHost}` : '● NOT FULLY LIVE'}
                      </div>
                      <StatusRow label="DNS" ok={status.dns.apex.resolves || status.dns.www.resolves}>
                        apex {status.dns.apex.resolves ? (status.dns.apex.a[0] || status.dns.apex.cname[0] || 'resolves') : 'no record'} · www {status.dns.www.resolves ? (status.dns.www.cname[0] || status.dns.www.a[0] || 'resolves') : 'no record'}
                      </StatusRow>
                      <StatusRow label="HTTPS" ok={status.http[status.redirect.expected].ok}>
                        {status.http[status.redirect.expected].status ?? '—'} · {status.http[status.redirect.expected].responseTimeMs}ms
                        {status.http[status.redirect.expected].error ? ` · ${status.http[status.redirect.expected].error}` : ''}
                      </StatusRow>
                      <StatusRow label="TLS certificate" ok={status.tls.ok}>
                        {status.tls.ok
                          ? `valid · ${status.tls.daysLeft} days left${status.tls.issuer ? ` · ${status.tls.issuer}` : ''}`
                          : (status.tls.error || 'invalid')}
                      </StatusRow>
                      <StatusRow label={`Redirect to ${status.redirect.expected}`} ok={status.redirect.ok}>
                        {status.redirect.ok == null ? 'could not determine' : status.redirect.ok ? 'other hostname redirects correctly' : 'the other hostname does not redirect here'}
                      </StatusRow>
                      <div className="text-[9px] text-ink/30">checked {new Date(status.checkedAt).toLocaleTimeString()}</div>
                    </div>
                  )}
                  {!status && !checkErr && !checking && <div className="text-[10px] text-ink/40">Run a check once DNS has had time to propagate (5–30 min after adding records).</div>}
                </section>
              )}

              {/* Analytics */}
              {analytics && analytics.isWeb !== false && aDraft && (
                <section className="border border-primary/15 bg-black/20 p-3">
                  <div className="text-[11px] text-primary/60 tracking-widest uppercase mb-2 flex items-center gap-1.5"><BarChart3 size={12} /> Analytics</div>
                  {aErr && <div className="text-red-400 text-[10px] border border-red-500/30 px-2 py-1 mb-2">{aErr}</div>}
                  <div className="text-[10px] text-ink/45 leading-snug mb-2">
                    Cookieless, privacy-friendly options only — the builder embeds the script and your own account collects the data. No cookie banner needed.
                  </div>
                  <select value={aDraft.provider} onChange={(e) => setAProvider(e.target.value)}
                    className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-primary focus:outline-none focus:border-primary/50">
                    {Object.entries(analytics.providers).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
                  </select>

                  {aDraft.provider && (analytics.providers[aDraft.provider]?.fields || []).length > 0 && (
                    <div className="mt-2 space-y-2">
                      {(analytics.providers[aDraft.provider].fields).map((f) => (
                        <label key={f} className="block">
                          <span className="text-[10px] text-primary/45 uppercase">{(A_FIELD_META[f] || [f])[0]}</span>
                          <input value={aDraft[f] || ''} onChange={(e) => setA(f, e.target.value)}
                            placeholder={(A_FIELD_META[f] || [f, ''])[1]}
                            className="w-full bg-black/30 border border-primary/20 px-2 py-1 text-[11px] text-primary font-mono focus:outline-none focus:border-primary/50 mt-0.5" />
                        </label>
                      ))}
                    </div>
                  )}

                  {aDraft.provider && analytics.providers[aDraft.provider]?.note && (
                    <div className="text-[9px] text-ink/35 leading-relaxed mt-2">{analytics.providers[aDraft.provider].note}</div>
                  )}

                  {analytics.snippet && JSON.stringify(aDraft) === JSON.stringify(analytics.analytics) && (
                    <div className="mt-2">
                      <div className="text-[9px] text-primary/40 uppercase mb-1">Embedded in &lt;head&gt;</div>
                      <div className="flex items-start gap-2 bg-black/40 border border-primary/15 px-2 py-1.5">
                        <code className="text-[9px] text-primary/70 break-all flex-1 leading-relaxed">{analytics.snippet}</code>
                        <CopyBtn text={analytics.snippet} />
                      </div>
                    </div>
                  )}

                  <button onClick={saveAnalytics} disabled={aBusy}
                    className="mt-2.5 flex items-center gap-1.5 px-3 py-1 border border-primary/40 text-primary/80 hover:border-primary hover:text-primary text-[10px] disabled:opacity-40">
                    {aBusy ? <Loader2 size={10} className="animate-spin" /> : aSaved ? <Check size={10} /> : <BarChart3 size={10} />}
                    {aSaved ? 'SAVED' : aDraft.provider ? 'SAVE ANALYTICS' : 'SAVE (NONE)'}
                  </button>
                  <span className="text-[9px] text-primary/35 ml-2">→ <span className="font-mono">.morpheus/analytics.json</span></span>
                </section>
              )}

              {/* Uptime monitoring */}
              {history?.connected && (
                <section className="border border-primary/15 bg-black/20 p-3">
                  <div className="text-[11px] text-primary/60 tracking-widest uppercase mb-2 flex items-center gap-1.5"><Activity size={12} /> Uptime monitoring</div>
                  {monitorErr && <div className="text-red-400 text-[10px] border border-red-500/30 px-2 py-1 mb-2">{monitorErr}</div>}
                  {history.monitoring?.active ? (
                    <>
                      <div className="text-[10px] text-green-400/90 mb-1.5">● ON — checks {history.monitoring.url || 'the site'} every {history.monitoring.intervalMinutes || 15} min from a GitHub Action in your repo. Opens an issue if it's down.</div>
                      <div className="flex items-center gap-2">
                        <select value={monitorInterval} onChange={(e) => setMonitorInterval(Number(e.target.value))}
                          className="bg-black/30 border border-primary/20 px-2 py-1 text-[10px] text-primary focus:outline-none">
                          {[15, 30, 60].map((n) => <option key={n} value={n}>every {n} min</option>)}
                        </select>
                        <button onClick={() => setupMonitor(monitorInterval)} disabled={monitorBusy}
                          className="text-[10px] text-primary/70 hover:text-primary border border-primary/25 hover:border-primary/60 px-2 py-1 disabled:opacity-40">
                          {monitorBusy === 'set' ? <Loader2 size={10} className="animate-spin" /> : 'UPDATE'}
                        </button>
                        <button onClick={removeMonitor} disabled={monitorBusy}
                          className="text-[10px] text-red-400/70 hover:text-red-400 border border-red-500/25 hover:border-red-500/50 px-2 py-1 disabled:opacity-40">
                          {monitorBusy === 'off' ? <Loader2 size={10} className="animate-spin" /> : 'TURN OFF'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-[10px] text-ink/45 leading-snug mb-1.5">
                        Add a check that runs on GitHub's schedule and opens an issue in your repo if the site stops responding. Needs a domain set above. Nothing runs on Morpheus.
                      </div>
                      <div className="flex items-center gap-2">
                        <select value={monitorInterval} onChange={(e) => setMonitorInterval(Number(e.target.value))}
                          className="bg-black/30 border border-primary/20 px-2 py-1 text-[10px] text-primary focus:outline-none">
                          {[15, 30, 60].map((n) => <option key={n} value={n}>every {n} min</option>)}
                        </select>
                        <button onClick={() => setupMonitor(monitorInterval)} disabled={monitorBusy || !savedDomain}
                          className="flex items-center gap-1 text-[10px] text-primary/80 hover:text-primary border border-primary/40 hover:border-primary px-2 py-1 disabled:opacity-40">
                          {monitorBusy === 'set' ? <Loader2 size={10} className="animate-spin" /> : <Activity size={10} />} TURN ON
                        </button>
                      </div>
                    </>
                  )}
                </section>
              )}

              {/* Deploy history + rollback */}
              <section>
                <div className="text-[11px] text-primary/55 tracking-widest uppercase mb-2 flex items-center gap-1.5"><History size={12} /> Deploy history</div>
                {historyErr && <div className="text-red-400 text-[10px] border border-red-500/30 px-2 py-1 mb-2">{historyErr}</div>}
                {rollbackDone && (
                  <div className="text-[10px] text-green-400/90 border border-green-500/30 px-2 py-1.5 mb-2 leading-snug">
                    Rolled back to {rollbackDone.rolledBackToSha.slice(0, 7)} as commit {rollbackDone.commitSha.slice(0, 7)}. Your host is redeploying now.
                  </div>
                )}
                {!history && !historyErr && <div className="text-[10px] text-primary/40 flex items-center gap-1.5"><Loader2 size={11} className="animate-spin" /> Loading commits…</div>}
                {history && !history.connected && (
                  <div className="text-[10px] text-ink/45 leading-snug">Connect this project to a GitHub repo (Export to GitHub) to see deploy history and roll back.</div>
                )}
                {history?.connected && (
                  <>
                    <div className="text-[10px] text-ink/40 mb-1.5">{history.repo} · {history.branch} — your host redeploys on every commit.</div>
                    <div className="border border-primary/15 divide-y divide-primary/10">
                      {history.commits.map((c) => {
                        const isHead = c.sha === history.headSha;
                        return (
                          <div key={c.sha} className="px-2 py-1.5">
                            <div className="flex items-start gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="text-[10px] text-ink/80 truncate">{c.message}</div>
                                <div className="text-[9px] text-ink/35 font-mono">
                                  {c.shortSha} · {c.author}{c.date ? ` · ${relTime(c.date)}` : ''}{isHead ? ' · LIVE' : ''}
                                </div>
                              </div>
                              {isHead ? (
                                <span className="text-[9px] text-green-400/70 shrink-0 mt-0.5">● current</span>
                              ) : (
                                <button onClick={() => rollback(c.sha)} disabled={!!rollingBack}
                                  className="flex items-center gap-1 text-[9px] text-primary/60 hover:text-primary border border-primary/25 hover:border-primary/60 px-1.5 py-0.5 shrink-0 disabled:opacity-40">
                                  {rollingBack === c.sha ? <Loader2 size={9} className="animate-spin" /> : <RotateCcw size={9} />} ROLL BACK
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="text-[9px] text-ink/30 mt-1.5">Rollback lands a new commit that restores every file to that point — nothing is force-pushed or lost.</div>
                  </>
                )}
              </section>
            </div>

            <div className="p-3 border-t border-primary/20 shrink-0 flex items-center gap-2">
              <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-1.5 border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-[11px] disabled:opacity-40">
                {saving ? <Loader2 size={12} className="animate-spin" /> : saved ? <Check size={12} /> : <Globe size={12} />}
                {saved ? 'SAVED' : 'SAVE DOMAIN'}
              </button>
              <span className="text-[10px] text-ink/40">Written to <span className="font-mono">.morpheus/site.json</span>.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
