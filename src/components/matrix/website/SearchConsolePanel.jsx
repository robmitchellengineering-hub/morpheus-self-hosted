import { useState, useEffect, useCallback } from 'react';
import { Loader2, ExternalLink, Search, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Real search performance, from the operator's own Google Search Console.
//
// WHY EVERY FIGURE IS LABELLED
//
// This panel sits beside keyword research, which shows what people type and
// deliberately shows no volume. These numbers are different in kind: Google's
// own, for the operator's own property. So each one says what it is and over what
// window, "low CTR" says which baseline it was judged against, and the panel says
// where backlink data is NOT available instead of leaving a gap someone assumes
// is an oversight. Nothing here is invented, and nothing here is estimated —
// lib/searchConsoleInsights.js's payload has no field for an estimate.

const micro = 'text-[9px] text-primary/35 uppercase tracking-wider';
const faint = 'text-[9px] text-primary/30';
const btn = 'inline-flex items-center gap-1.5 px-2.5 h-[28px] border border-primary/25 text-[10px] uppercase tracking-wider text-primary/80 hover:text-primary hover:border-primary/50 disabled:opacity-40 disabled:hover:border-primary/25';

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString());
const pos = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(1));

function Stat({ label, value, hint }) {
  return (
    <div className="border border-primary/15 px-2.5 py-2">
      <div className={micro}>{label}</div>
      <div className="text-[15px] text-primary/90 mt-0.5">{value}</div>
      {hint ? <div className={faint}>{hint}</div> : null}
    </div>
  );
}

function Row({ children, cols = 'grid-cols-[1fr_auto]' }) {
  return <div className={`grid ${cols} gap-2 border-b border-primary/10 py-1.5 last:border-b-0`}>{children}</div>;
}

// `widget` means this is running under a widget token inside an embed. The
// connect route is deliberately `blockWidget` on the server (an OAuth handshake
// from an embedded page is not something the owner consented to), so offering the
// button here would be a dead end that 403s after the click.
export default function SearchConsolePanel({ onNote, widget = false }) {
  const [status, setStatus] = useState(null);   // { connected, email, property, needsProperty }
  const [busy, setBusy] = useState(null);       // 'status' | 'overview' | 'properties' | 'select' | 'disconnect'
  const [properties, setProperties] = useState(null);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);       // the overview payload
  const [days, setDays] = useState(28);
  const [err, setErr] = useState(null);

  const call = useCallback(async (body) => {
    const res = await base44.functions.invoke('searchConsoleAction', body);
    return res.data;
  }, []);

  const loadStatus = useCallback(async () => {
    setBusy('status'); setErr(null);
    try {
      setStatus(await call({ action: 'status' }));
    } catch (e) {
      setErr({ message: e?.data?.error || e.message, code: e?.data?.code });
    } finally { setBusy(null); }
  }, [call]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const loadOverview = useCallback(async (windowDays = days) => {
    setBusy('overview'); setErr(null);
    try {
      setData(await call({ action: 'overview', days: windowDays }));
    } catch (e) {
      setErr({ message: e?.data?.error || e.message, code: e?.data?.code });
    } finally { setBusy(null); }
  }, [call, days]);

  const loadProperties = useCallback(async () => {
    setBusy('properties'); setErr(null);
    try {
      const r = await call({ action: 'properties' });
      setProperties(r.properties || []);
    } catch (e) {
      setErr({ message: e?.data?.error || e.message, code: e?.data?.code });
    } finally { setBusy(null); }
  }, [call]);

  const selectProperty = useCallback(async (property) => {
    setBusy('select'); setErr(null);
    try {
      await call({ action: 'select-property', property });
      setProperties(null);
      await loadStatus();
      await loadOverview(days);
    } catch (e) {
      setErr({ message: e?.data?.error || e.message, code: e?.data?.code });
    } finally { setBusy(null); }
  }, [call, loadStatus, loadOverview, days]);

  const connect = async () => {
    // A top-level navigation to Google, so the token rides in the query (the
    // server's extractToken accepts it for exactly this).
    window.location.href = await base44.connectors.connectSearchConsole(window.location.pathname);
  };

  const disconnect = async () => {
    setBusy('disconnect'); setErr(null);
    try {
      await base44.connectors.disconnectSearchConsole();
      setData(null); setProperties(null);
      await loadStatus();
      onNote?.('Search Console disconnected.');
    } catch (e) {
      setErr({ message: e?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  const ErrorBox = () => (err ? (
    <div className="border border-red-500/30 bg-red-500/5 px-2.5 py-2 space-y-1">
      <div className="text-[10px] text-red-300/90">{err.message}</div>
      {err.code === 'API_NOT_ENABLED' ? (
        <a className="inline-flex items-center gap-1 text-[10px] text-primary/70 underline"
          href="https://console.cloud.google.com/apis/library/searchconsole.googleapis.com" target="_blank" rel="noreferrer">
          Open Google Cloud to enable it <ExternalLink size={10} />
        </a>
      ) : null}
    </div>
  ) : null);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <button className={btn} onClick={() => { setOpen((v) => !v); if (!open && status?.connected && status?.property) loadOverview(days); }} disabled={busy === 'status'}>
          {busy === 'status' || busy === 'overview' ? <Loader2 size={11} className="animate-spin" /> : <Search size={11} />} SEARCH CONSOLE
          {status?.connected ? <span className="text-primary/50 normal-case tracking-normal">· {status.property || 'no property chosen'}</span> : null}
        </button>
        {open ? (
          <button className={btn} onClick={() => loadOverview(days)} disabled={!status?.property || busy === 'overview'} title="Refresh from Google">
            <RefreshCw size={11} /> REFRESH
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="space-y-2.5 border border-primary/15 p-2.5">
          <ErrorBox />

          {/* Not connected — one tap to Google, and the panel says what it will ask for. */}
          {status && !status.connected ? (
            <div className="space-y-2">
              <div className="text-[10px] text-ink/60">
                Connect your own Google Search Console to see the real queries, clicks, impressions, CTR and average
                position for your site. Read-only: Morpheus is asking to <span className="text-primary/80">view</span> your
                search performance and nothing else.
              </div>
              {widget ? (
                <div className="text-[10px] text-ink/60 border border-primary/20 px-2.5 py-2">
                  Search Console is not connected for this site yet. Connecting needs your Google account, so it has
                  to be done from Morpheus itself (WEBSITE → SEO → SEARCH CONSOLE) — not from an embedded page.
                </div>
              ) : (
                <button className={btn} onClick={connect}><ExternalLink size={11} /> CONNECT SEARCH CONSOLE</button>
              )}
              <div className={faint}>
                Your site has to be a property in Search Console already. If it is not, add and verify it there first —
                Morpheus cannot verify it for you.
              </div>
            </div>
          ) : null}

          {/* Connected, but no property chosen yet. */}
          {status?.connected && !status?.property ? (
            <div className="space-y-2">
              <div className="text-[10px] text-ink/60">
                Connected as <span className="text-primary/80">{status.email}</span>. Choose which property to read —
                Google lists what this account can see.
              </div>
              <div className="flex items-center gap-2">
                <button className={btn} onClick={loadProperties} disabled={busy === 'properties'}>
                  {busy === 'properties' ? <Loader2 size={11} className="animate-spin" /> : <Search size={11} />} LIST PROPERTIES
                </button>
                <button className={btn} onClick={disconnect} disabled={busy === 'disconnect'}>DISCONNECT</button>
              </div>
              {properties ? (properties.length ? (
                <div className="space-y-1">
                  {properties.map((p) => (
                    <button key={p.siteUrl} onClick={() => selectProperty(p.siteUrl)} disabled={!p.readable || busy === 'select'}
                      className="w-full text-left border border-primary/15 px-2.5 py-1.5 hover:border-primary/40 disabled:opacity-40">
                      <div className="text-[11px] text-ink/85 break-all">{p.siteUrl}</div>
                      <div className={faint}>
                        {p.permissionLevel}
                        {p.readable ? '' : ' — Google says this account cannot read performance for it'}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-ink/50">
                  This Google account has no Search Console properties. Add and verify your site at{' '}
                  <a className="underline" href="https://search.google.com/search-console" target="_blank" rel="noreferrer">search.google.com/search-console</a>{' '}
                  first, then list again.
                </div>
              )) : null}
            </div>
          ) : null}

          {/* Connected with a property — the real data. */}
          {status?.connected && status?.property ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] text-ink/60 break-all">{status.property}</div>
                <button className={btn} onClick={disconnect} disabled={busy === 'disconnect'}>DISCONNECT</button>
              </div>

              <div className="flex items-center gap-1.5">
                {[7, 28, 90].map((d) => (
                  <button key={d} onClick={() => { setDays(d); loadOverview(d); }}
                    className={`${btn} ${days === d ? 'border-primary/60 text-primary' : ''}`} disabled={busy === 'overview'}>
                    {d} DAYS
                  </button>
                ))}
              </div>

              {busy === 'overview' && !data ? <div className="text-[10px] text-ink/40">Reading your search performance from Google…</div> : null}

              {data ? (data.empty ? (
                <div className="text-[10px] text-ink/50">
                  Google returned no search data for this property in the last {data.days} days. That is a real answer —
                  the call succeeded. A brand-new or unindexed site looks exactly like this.
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <Stat label="Clicks" value={num(data.totals.clicks)} hint={`${data.totals.rows} queries`} />
                    <Stat label="Impressions" value={num(data.totals.impressions)} hint={`last ${data.days} days`} />
                    <Stat label="CTR" value={pct(data.totals.ctr)} hint="clicks ÷ impressions" />
                    <Stat label="Avg position" value={pos(data.totals.position)} hint="impression-weighted" />
                  </div>

                  {/* The two "what to do next" lists, each with its own reasoning. */}
                  <div className="space-y-1">
                    <div className={micro}>striking distance · positions 8–20, at least 20 impressions</div>
                    {data.strikingDistance.length ? data.strikingDistance.map((r) => (
                      <Row key={r.key}>
                        <div className="text-[11px] text-ink/85 break-all">{r.key}</div>
                        <div className="text-[10px] text-ink/55 text-right whitespace-nowrap">
                          #{pos(r.position)} · {num(r.impressions)} impr · {pct(r.ctr)}
                        </div>
                      </Row>
                    )) : (
                      <div className={faint}>
                        Nothing on page two with enough impressions to be worth nudging yet.
                      </div>
                    )}
                  </div>

                  <div className="space-y-1">
                    <div className={micro}>low ctr · versus your own median for the same positions</div>
                    {data.lowCtr.length ? data.lowCtr.map((r) => (
                      <Row key={r.key} cols="grid-cols-[1fr_auto]">
                        <div className="text-[11px] text-ink/85 break-all">{r.key}</div>
                        <div className="text-[10px] text-ink/55 text-right whitespace-nowrap">
                          {pct(r.ctr)} vs {pct(r.bandMedianCtr)} at #{pos(r.position)} · {num(r.impressions)} impr
                        </div>
                      </Row>
                    )) : (
                      <div className={faint}>
                        No query is underperforming your own average for where it ranks.
                      </div>
                    )}
                    {data.bandsThinOnData.length ? (
                      <div className={faint}>
                        Not judged for positions {data.bandsThinOnData.join(', ')} — too few of your own queries there to
                        know what normal looks like.
                      </div>
                    ) : null}
                  </div>

                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className={micro}>top queries</div>
                      {data.topQueries.map((r) => (
                        <Row key={`q-${r.key}`}>
                          <div className="text-[11px] text-ink/80 break-all">{r.key}</div>
                          <div className="text-[10px] text-ink/55 text-right whitespace-nowrap">
                            {num(r.clicks)} clicks · #{pos(r.position)}
                          </div>
                        </Row>
                      ))}
                    </div>
                    <div className="space-y-1">
                      <div className={micro}>top pages</div>
                      {data.topPages.map((r) => (
                        <Row key={`p-${r.key}`}>
                          <div className="text-[11px] text-ink/80 break-all">{String(r.key).replace(/^https?:\/\/[^/]+/, '') || '/'}</div>
                          <div className="text-[10px] text-ink/55 text-right whitespace-nowrap">
                            {num(r.clicks)} clicks · {num(r.impressions)} impr
                          </div>
                        </Row>
                      ))}
                    </div>
                  </div>

                  {/* Who links to you is NOT in the API. Say so, and hand over the
                      one place the answer actually lives. */}
                  <div className="border-t border-primary/15 pt-2 space-y-1">
                    <div className={faint}>{data.disclosure.notIncluded}</div>
                    <a className="inline-flex items-center gap-1 text-[10px] text-primary/70 underline"
                      href={data.linksReportUrl} target="_blank" rel="noreferrer">
                      Open the Links report in Search Console <ExternalLink size={10} />
                    </a>
                    <div className={faint}>
                      {data.disclosure.source} · {data.disclosure.window}. {data.disclosure.noEstimates} {data.disclosure.windowLabel}.
                      {' '}Window: {data.range.startDate} → {data.range.endDate}.
                    </div>
                  </div>
                </div>
              )) : (
                <div className={faint}>Reloading reads Google again — nothing is cached here.</div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
