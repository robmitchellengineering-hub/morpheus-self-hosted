import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Loader2, ExternalLink, Sparkles } from 'lucide-react';
import MatrixRain from '@/components/matrix/MatrixRain';

// Styled to match src/pages/CostTracker.jsx's design language (2026-09-12,
// Rob: "format the [page] with the same colors and effects and fonts as
// the cost tracker, it looks better") — font-display/neon-glow heading,
// the semantic status-* color tokens instead of raw Tailwind colors, and
// the same bordered/filled card + table conventions, rather than this
// page's own one-off styling.
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar,
} from 'recharts';

/**
 * Aliceinthealice — Live Wikimedia Editor Report.
 *
 * A brag page for Alice Woods (Education & Projects Coordinator, Wikimedia
 * Australia — https://wikimedia.org.au/wiki/User:Alice_Woods), who edits as
 * "Aliceinthealice". Talks directly to public Wikimedia APIs on every load —
 * no backend, no database, nothing cached or stored. What you see is exactly
 * what her account looks like right now.
 *
 * Rebuilt 2026-09-12 — the first version (built through self-dev) called
 * XTools endpoints that don't exist (e.g. "/user/global_stats/{username}",
 * no such route — XTools' real per-wiki endpoints all take a project domain)
 * and guessed a Wikimedia Australia wiki username ("Alice_Woods") that isn't
 * a real account there, so it never resolved any data. Every endpoint below
 * was hit directly and confirmed working, against her real account, before
 * being wired in here — see XTools' own interactive docs at
 * https://xtools.wmcloud.org/api for the real route list.
 */

const UA = 'MorpheusStatsPage/1.0 (+https://morpheus.nz)';
const TIMEOUT_MS = 20000;
const XTOOLS = 'https://xtools.wmcloud.org/api';
const USERNAME = 'Aliceinthealice';
// The three wikis she's actually active on, confirmed by hitting XTools
// directly rather than assumed. Order = display order. `tone` is a purely
// decorative color key (one of the app's real status-* tokens) so each wiki
// reads as its own color at a glance in the table and activity feed below —
// not a severity signal, just variety.
const WIKIS = [
  { id: 'www.wikidata.org', label: 'Wikidata', tone: 'info' },
  { id: 'commons.wikimedia.org', label: 'Wikimedia Commons', tone: 'warning' },
  { id: 'en.wikipedia.org', label: 'English Wikipedia', tone: 'success' },
];
const WIKI_TONE = Object.fromEntries(WIKIS.map((w) => [w.id, w.tone]));
// One shared decorative palette (the app's real status-* tokens) reused for
// wiki dots below AND the headline stat cards — every class string here is a
// full literal (never templated with the tone variable) so Tailwind's
// content scanner can actually find and keep it at build time.
const TONE_DOT = {
  info: 'bg-info shadow-[0_0_6px_hsl(var(--status-info)/0.7)]',
  warning: 'bg-warning shadow-[0_0_6px_hsl(var(--status-warning)/0.7)]',
  success: 'bg-success shadow-[0_0_6px_hsl(var(--status-success)/0.7)]',
  danger: 'bg-danger shadow-[0_0_6px_hsl(var(--status-danger)/0.7)]',
};
const TONE_TEXT = { info: 'text-info', warning: 'text-warning', success: 'text-success', danger: 'text-danger' };
const TONE_CARD = {
  info: 'border-info/30 bg-info/5',
  warning: 'border-warning/30 bg-warning/5',
  success: 'border-success/30 bg-success/5',
  danger: 'border-danger/30 bg-danger/5',
};
const TONE_BADGE = {
  info: 'border-info/40 bg-info/10 text-info',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  success: 'border-success/40 bg-success/10 text-success',
  danger: 'border-danger/40 bg-danger/10 text-danger',
};
function WikiDot({ id }) {
  const tone = WIKI_TONE[id] || 'info';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${TONE_DOT[tone]}`} />;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function AliceStats() {
  const [perWiki, setPerWiki] = useState(null); // { [wikiId]: simple_editcount response }
  const [globalInfo, setGlobalInfo] = useState(null); // meta globaluserinfo
  const [recent, setRecent] = useState([]); // globalcontribs feed
  const [monthCounts, setMonthCounts] = useState([]); // month_counts for her top wiki
  const [namespaceTotals, setNamespaceTotals] = useState(null);
  const [topEdits, setTopEdits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Per-wiki edit counts — the headline numbers. Each wiki fetched
      // independently so one failing never blanks the rest.
      const wikiResults = await Promise.all(
        WIKIS.map((w) => fetchJson(`${XTOOLS}/user/simple_editcount/${w.id}/${USERNAME}`).catch(() => null)),
      );
      const perWikiMap = {};
      WIKIS.forEach((w, i) => { perWikiMap[w.id] = wikiResults[i]; });
      setPerWiki(perWikiMap);

      // 2. Global account info (registration date, global rights) from Meta.
      const gui = await fetchJson(
        `https://meta.wikimedia.org/w/api.php?action=query&meta=globaluserinfo&format=json&origin=*&guiprop=editcount|groups|merged&guiuser=${encodeURIComponent(USERNAME)}`,
      ).then((r) => r?.query?.globaluserinfo || null).catch(() => null);
      setGlobalInfo(gui);

      // 3. Recent activity across every wiki she edits — the genuinely
      // "live" part: whatever she did most recently, wherever it was.
      // No limit param on this endpoint (confirmed against the real API —
      // a "?limit=" query string is silently ignored); it returns its own
      // default page size, sliced down for display here.
      const gc = await fetchJson(`${XTOOLS}/user/globalcontribs/${USERNAME}`)
        .then((r) => (r?.globalcontribs || []).slice(0, 15))
        .catch(() => []);
      setRecent(gc);

      // 4/5/6. Deep-dive (month activity, namespace split, top pages) on
      // whichever wiki actually has the data — XTools gates month_counts /
      // top_edits behind a per-user on-wiki opt-in (confirmed live: hers is
      // 401 "has not opted in" on Wikidata, her highest-edit wiki, but
      // fine on English Wikipedia), so picking purely by edit count can
      // land on a wiki that 401s every detail call. Try each wiki in
      // edit-count order and keep the first that actually returns data.
      const wikisByEdits = WIKIS.map((w) => ({ w, count: perWikiMap[w.id]?.live_edit_count || 0 }))
        .sort((a, b) => b.count - a.count)
        .map((x) => x.w);
      let topWiki = wikisByEdits[0];
      let mc = null, ns = null, te = null;
      for (const candidate of wikisByEdits) {
        const [mcTry, nsTry, teTry] = await Promise.all([
          fetchJson(`${XTOOLS}/user/month_counts/${candidate.id}/${USERNAME}`).catch(() => null),
          fetchJson(`${XTOOLS}/user/namespace_totals/${candidate.id}/${USERNAME}`).catch(() => null),
          fetchJson(`${XTOOLS}/user/top_edits/${candidate.id}/${USERNAME}`).catch(() => null),
        ]);
        if (mcTry?.totals) { topWiki = candidate; mc = mcTry; ns = nsTry; te = teTry; break; }
      }
      if (mc?.totals) {
        // totals: { [namespace]: { 'YYYY-MM': count } } — flatten to a
        // single chronological series across every namespace.
        const byMonth = {};
        for (const nsCounts of Object.values(mc.totals)) {
          for (const [month, count] of Object.entries(nsCounts)) {
            byMonth[month] = (byMonth[month] || 0) + count;
          }
        }
        setMonthCounts(Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([month, edits]) => ({ month, edits })));
      }
      if (ns?.namespace_totals) setNamespaceTotals({ wiki: topWiki.label, totals: ns.namespace_totals });
      const teList = te?.top_edits ? Object.values(te.top_edits).flat() : [];
      setTopEdits(teList.slice(0, 8));

      const gotAnything = wikiResults.some(Boolean) || gui || gc.length > 0;
      if (!gotAnything) setError('Could not reach any Wikimedia API right now — try refreshing in a moment.');
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Wikidata referencing work is naturally many small consecutive edits to
  // the same item (confirmed live: 15 of her last 15 edits were all one
  // item) — collapse consecutive same-page entries into one row with a
  // count instead of showing the same line over and over.
  const recentGrouped = [];
  for (const c of recent) {
    const last = recentGrouped[recentGrouped.length - 1];
    const key = `${c.project}|${c.full_page_title || c.page_title}`;
    if (last && last.key === key) { last.count += 1; }
    else recentGrouped.push({ key, project: c.project, title: c.full_page_title || c.page_title, count: 1, timestamp: c.timestamp });
  }

  const totalLive = perWiki ? Object.values(perWiki).reduce((sum, w) => sum + (w?.live_edit_count || 0), 0) : 0;
  const totalCreated = perWiki ? Object.values(perWiki).reduce((sum, w) => sum + (w?.creation_count || 0), 0) : 0;
  const yearsActive = globalInfo?.registration
    ? ((Date.now() - new Date(globalInfo.registration).getTime()) / (365.25 * 24 * 3600 * 1000)).toFixed(1)
    : null;
  const isEventOrganizer = perWiki && Object.values(perWiki).some((w) => (w?.user_groups || []).includes('event-organizer'));

  return (
    <div className="relative min-h-screen bg-background text-primary font-mono">
      <MatrixRain opacity={0.05} />
      <div className="relative z-10 max-w-4xl mx-auto px-6 py-10 safe-top">
        <Link to="/workspace" className="inline-flex items-center gap-1.5 text-primary/60 hover:text-primary text-sm mb-6 transition-colors">
          <ArrowLeft size={14} /> BACK
        </Link>

        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Sparkles size={24} className="text-primary neon-glow" />
            <h1 className="text-2xl md:text-3xl font-display tracking-widest neon-glow text-heading">ALICEINTHEALICE</h1>
            <span className="text-[10px] border border-primary/40 text-primary/70 px-2 py-0.5 rounded-full">LIVE EDITOR REPORT</span>
          </div>
          <button onClick={load} disabled={loading} className="flex items-center gap-1.5 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-xs transition-colors disabled:opacity-40">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} REFRESH
          </button>
        </div>
        <p className="text-primary/60 text-sm mb-8">
          // Everything on this page is pulled live from public Wikimedia APIs, fresh on every load — nothing is stored. Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'}
        </p>

        {/* Bio — real, sourced facts, not invented */}
        <div className="border border-primary/20 bg-primary/5 px-4 py-3 mb-8 text-sm text-ink leading-relaxed">
          <p className="mb-2">
            <strong className="text-primary">Alice Woods</strong> is the Education &amp; Projects Coordinator at{' '}
            <a href="https://wikimedia.org.au" target="_blank" rel="noreferrer" className="underline hover:text-primary inline-flex items-center gap-1">
              Wikimedia Australia <ExternalLink size={10} />
            </a>{' '}
            since September 2023, coming from a library and archives background. She runs real-world edit-a-thons —
            including a gender-equity-in-art event at the Gallery in February 2024 — and edits under the name{' '}
            <strong className="text-primary">Aliceinthealice</strong> across Wikipedia, Wikidata, and Commons, where she
            holds "event organizer" rights recognising exactly that community-building work.
          </p>
          <p className="text-primary/50 text-[11px]">
            Sources:{' '}
            <a href="https://wikimedia.org.au/wiki/User:Alice_Woods" target="_blank" rel="noreferrer" className="underline hover:text-primary/80">her Wikimedia Australia user page</a>
            {', '}
            <a href="https://www.linkedin.com/in/alice-woods-b3b83776/" target="_blank" rel="noreferrer" className="underline hover:text-primary/80">LinkedIn</a>
            {', '}
            <a href="https://outreach.wikimedia.org/wiki/GLAM/Newsletter/February_2024/Contents/Australia_report" target="_blank" rel="noreferrer" className="underline hover:text-primary/80">Feb 2024 GLAM newsletter</a>.
          </p>
        </div>

        {error && (
          <div className="text-danger text-sm border border-danger/30 px-3 py-2 mb-4">{error}</div>
        )}

        {loading && !perWiki ? (
          <div className="flex items-center gap-2 text-primary/60 text-sm py-12 justify-center">
            <Loader2 size={16} className="animate-spin" /> Loading live Wikimedia data...
          </div>
        ) : (
          <>
            {/* Headline numbers — each card its own accent color (purely
                decorative, like the wiki dots below) so the row doesn't read
                as one flat green block. Only the hero figure keeps the neon
                glow treatment; the rest sit in near-white "ink" so the page
                isn't wall-to-wall green. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
              {[
                { label: 'Edits, every wiki', value: fmt(globalInfo?.editcount ?? totalLive), tone: 'success', hero: true },
                { label: 'Pages created', value: fmt(totalCreated), tone: 'info' },
                { label: 'Years editing', value: yearsActive ? `${yearsActive}y` : '—', tone: 'warning' },
                { label: 'Community role', value: isEventOrganizer ? 'Event Organizer' : '—', tone: 'danger', badge: true },
              ].map(({ label, value, tone, hero, badge }) => (
                <div key={label} className={`border p-4 ${TONE_CARD[tone]}`}>
                  <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">{label.toUpperCase()}</p>
                  {badge && value !== '—' ? (
                    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 border rounded-full ${TONE_BADGE[tone]}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${TONE_DOT[tone]}`} />
                      {value}
                    </span>
                  ) : hero ? (
                    <p className={`text-xl neon-glow ${TONE_TEXT[tone]}`}>{value}</p>
                  ) : (
                    <p className="text-xl text-ink">{value}</p>
                  )}
                </div>
              ))}
            </div>

            {/* Per-wiki breakdown */}
            <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-2">BY WIKI</p>
            <div className="overflow-x-auto border border-primary/20 mb-8">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-primary/20 text-primary/50 text-left">
                    <th className="px-3 py-2 font-normal">Wiki</th>
                    <th className="px-3 py-2 font-normal text-right">Live edits</th>
                    <th className="px-3 py-2 font-normal text-right">Deleted</th>
                    <th className="px-3 py-2 font-normal text-right">Pages created</th>
                  </tr>
                </thead>
                <tbody>
                  {WIKIS.map((w) => {
                    const d = perWiki?.[w.id];
                    return (
                      <tr key={w.id} className="border-b border-primary/10 last:border-0 align-top">
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-2 text-ink">
                            <WikiDot id={w.id} />
                            {w.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-ink">{d ? fmt(d.live_edit_count) : 'no data'}</td>
                        <td className="px-3 py-2 text-right text-primary/70">{d ? fmt(d.deleted_edit_count) : '—'}</td>
                        <td className="px-3 py-2 text-right text-primary/70">{d ? fmt(d.creation_count) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Monthly activity chart */}
            {monthCounts.length > 1 && (
              <>
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-2">MONTHLY ACTIVITY — {namespaceTotals?.wiki?.toUpperCase() || ''}</p>
                <div className="border border-primary/20 bg-primary/5 p-3 mb-8" style={{ height: 220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={monthCounts.slice(-36)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(57,255,20,0.1)" />
                      <XAxis dataKey="month" tick={{ fill: 'rgba(57,255,20,0.4)', fontSize: 9 }} interval={Math.ceil(monthCounts.length / 12)} />
                      <YAxis tick={{ fill: 'rgba(57,255,20,0.4)', fontSize: 9 }} />
                      <Tooltip contentStyle={{ background: '#05130a', border: '1px solid rgba(57,255,20,0.3)', fontSize: 11 }} />
                      <Line type="monotone" dataKey="edits" stroke="#39ff14" strokeWidth={1.5} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}

            {/* Namespace split */}
            {namespaceTotals && (
              <>
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-2">WHERE THE EDITS GO — {namespaceTotals.wiki.toUpperCase()}</p>
                <div className="border border-primary/20 bg-primary/5 p-3 mb-8" style={{ height: 200 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={Object.entries(namespaceTotals.totals).map(([ns, count]) => ({ ns: ns === '0' ? 'Main' : `NS ${ns}`, count })).sort((a, b) => b.count - a.count).slice(0, 8)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(57,255,20,0.1)" />
                      <XAxis dataKey="ns" tick={{ fill: 'rgba(57,255,20,0.4)', fontSize: 9 }} />
                      <YAxis tick={{ fill: 'rgba(57,255,20,0.4)', fontSize: 9 }} />
                      <Tooltip contentStyle={{ background: '#05130a', border: '1px solid rgba(57,255,20,0.3)', fontSize: 11 }} />
                      <Bar dataKey="count" fill="#39ff14" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}

            {/* Top edited pages */}
            {topEdits.length > 0 && (
              <>
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-2">MOST-EDITED PAGES — {namespaceTotals?.wiki?.toUpperCase()}</p>
                <div className="border border-primary/20 divide-y divide-primary/10 mb-8">
                  {topEdits.map((p, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-2 text-xs">
                      <span className="text-ink truncate">{p.page_title || p.full_page_title}</span>
                      <span className="text-primary/40 shrink-0 ml-3">{fmt(p.count)} edits</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Live recent activity feed */}
            <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-2">RIGHT NOW — MOST RECENT ACTIVITY, ANY WIKI</p>
            <div className="border border-primary/20 divide-y divide-primary/10">
              {recentGrouped.length === 0 ? (
                <div className="px-3 py-4 text-primary/40 text-xs text-center">No recent activity found.</div>
              ) : recentGrouped.map((c) => (
                <div key={c.key} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <div className="min-w-0 flex items-start gap-2">
                    <WikiDot id={c.project} />
                    <div className="min-w-0">
                      <span className="text-ink truncate block">{c.title}{c.count > 1 ? ` — ${c.count} edits` : ''}</span>
                      <span className={`text-[10px] ${TONE_TEXT[WIKI_TONE[c.project]] || 'text-primary/50'}`}>{c.project}</span>
                    </div>
                  </div>
                  <span className="text-primary/40 shrink-0 text-[10px]">{timeAgo(c.timestamp)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
