import { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Loader2, ExternalLink, AlertTriangle } from 'lucide-react';
import MatrixRain from '@/components/matrix/MatrixRain';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts';

/**
 * Aliceinthealice — Live Wikimedia Editor Report
 *
 * This page builds a complete, explainable report on the Wikimedia editor
 * Aliceinthealice (meta) / Alice_Woods (wikimedia.org.au). It talks directly
 * to the public MediaWiki APIs, no backend or database involved.
 *
 * Data sources:
 *  - meta.wikimedia.org/w/api.php — global account info (total edits, merged
 *    wikis, registration date) via list=globaluserinfo.
 *  - Individual wiki APIs (en.wikipedia, meta, Wikidata, wikimedia.org.au) —
 *    per-wiki user info and the most recent 500 contributions per wiki.
 * The page is public (brag page for the editor) and admin-friendly:
 * it never requires a login and never stores anything.
 */

const UA = 'MorpheusStatsPage/1.0 (+https://morpheus.nz)';
const TIMEOUT_MS = 15000;
const CONTRIB_LIMIT = 500; // number of recent edits fetched per wiki

async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Wikis where Alice has an account that we can fetch from.
// `user` is the exact username on that wiki. For wikimedia.org.au the
// username is Alice_Woods; everywhere else it's Aliceinthealice.
const WIKIS = [
  {
    id: 'enwiki',
    name: 'English Wikipedia',
    color: '#39ff14',
    api: 'https://en.wikipedia.org/w/api.php',
    user: 'Aliceinthealice',
  },
  {
    id: 'metawiki',
    name: 'Meta-Wiki',
    color: '#00e5ff',
    api: 'https://meta.wikimedia.org/w/api.php',
    user: 'Aliceinthealice',
  },
  {
    id: 'wikidatawiki',
    name: 'Wikidata',
    color: '#ffd700',
    api: 'https://www.wikidata.org/w/api.php',
    user: 'Aliceinthealice',
  },
  {
    id: 'mediawiki',
    name: 'Wikimedia AU',
    color: '#ff9f40',
    api: 'https://wikimedia.org.au/w/api.php',
    user: 'Alice_Woods',
  },
];

const NS_NAMES = {
  0: 'Main',
  1: 'Talk',
  2: 'User',
  3: 'User talk',
  4: 'Project',
  5: 'Project talk',
  6: 'File',
  7: 'File talk',
  8: 'MediaWiki',
  9: 'MediaWiki talk',
  10: 'Template',
  11: 'Template talk',
  12: 'Help',
  13: 'Help talk',
  14: 'Category',
  15: 'Category talk',
  100: 'Portal',
  101: 'Portal talk',
  828: 'Module',
  829: 'Module talk',
};

function nsName(ns) {
  return NS_NAMES[ns] || `Namespace ${ns}`;
}

function formatNumber(n) {
  return new Intl.NumberFormat().format(n || 0);
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'short',
    year: '2-digit',
  });
}

export default function AliceStats() {
  const [globalInfo, setGlobalInfo] = useState(null);
  const [wikiStats, setWikiStats] = useState({}); // { wikiId: { userInfo, contributions, error } }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [retryTrigger, setRetryTrigger] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Global account info
      const globalRes = await fetchJson(
        `https://meta.wikimedia.org/w/api.php?action=query&list=globaluserinfo&format=json&origin=*&guiprop=editcount|groups|merged|registration&guiuser=Aliceinthealice`,
      );
      const gui = globalRes?.query?.globaluserinfo || null;
      setGlobalInfo(gui);

      // 2. Per-wiki user info + recent contributions (parallel)
      const results = await Promise.all(
        WIKIS.map(async (wiki) => {
          const userParam = encodeURIComponent(wiki.user);
          const result = {
            wikiId: wiki.id,
            userInfo: null,
            contributions: [],
            error: null,
          };
          try {
            const userInfoRes = await fetchJson(
              `${wiki.api}?action=query&list=users&ususers=${userParam}&usprop=editcount|groups|registration&format=json&origin=*`,
            );
            result.userInfo = userInfoRes?.query?.users?.[0] || null;
          } catch (err) {
            result.error = `User info failed: ${err.message}`;
          }
          try {
            const contribRes = await fetchJson(
              `${wiki.api}?action=query&list=usercontribs&ucuser=${userParam}&uclimit=${CONTRIB_LIMIT}&ucprop=title|timestamp|comment|size|sizediff|flags&format=json&origin=*`,
            );
            result.contributions = contribRes?.query?.usercontribs || [];
          } catch (err) {
            result.error = result.error
              ? `${result.error}; contributions failed: ${err.message}`
              : `Contributions failed: ${err.message}`;
          }
          return result;
        }),
      );

      const stats = {};
      results.forEach((r) => {
        stats[r.wikiId] = {
          userInfo: r.userInfo,
          contributions: r.contributions,
          error: r.error,
        };
      });
      setWikiStats(stats);
      setLastUpdated(new Date().toISOString());
    } catch (err) {
      setError(err.message || 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, retryTrigger]);

  // ── Derived data ────────────────────────────────────────────────────────
  const mergedWikis = useMemo(() => globalInfo?.merged || [], [globalInfo]);

  // Per-wiki edit count. For unified wikis, prefer the count from
  // globaluserinfo.merged (which includes deleted edits?); for the standalone
  // AUD wiki, use the local user info if present, else count contributions.
  const wikiEditCounts = useMemo(() => {
    const counts = {};
    WIKIS.forEach((wiki) => {
      if (wiki.id === 'mediawiki') {
        const info = wikiStats?.mediawiki?.userInfo;
        if (info && !info.missing && typeof info.editcount === 'number') {
          counts[wiki.id] = info.editcount;
        } else {
          counts[wiki.id] = wikiStats?.mediawiki?.contributions?.length || 0;
        }
      } else {
        const mergedEntry = mergedWikis.find((m) => m.id === wiki.id);
        if (mergedEntry && typeof mergedEntry.editcount === 'number') {
          counts[wiki.id] = mergedEntry.editcount;
        } else {
          const info = wikiStats?.[wiki.id]?.userInfo;
          if (info && !info.missing && typeof info.editcount === 'number') {
            counts[wiki.id] = info.editcount;
          } else {
            counts[wiki.id] = 0;
          }
        }
      }
    });
    return counts;
  }, [mergedWikis, wikiStats]);

  const totalEdits = useMemo(() => {
    const sum = Object.values(wikiEditCounts).reduce((a, b) => a + (Number(b) || 0), 0);
    // If globalInfo.editcount is available and larger (it should be the sum
    // across all wikis), prefer that as the headline number; it also counts
    // wikis not explicitly listed here.
    if (globalInfo?.editcount && Number(globalInfo.editcount) > sum) {
      return Number(globalInfo.editcount);
    }
    return sum;
  }, [wikiEditCounts, globalInfo]);

  const activeWikis = useMemo(() => {
    let count = 0;
    // Count merged wikis with editcount > 0
    mergedWikis.forEach((w) => {
      if (Number(w.editcount) > 0) count += 1;
    });
    // Add the AU wiki if it has edits and isn't in the merged list.
    const auInMerged = mergedWikis.some((w) => w.id === 'mediawiki');
    if (!auInMerged && (wikiStats?.mediawiki?.contributions?.length > 0 || wikiEditCounts['mediawiki'] > 0)) {
      count += 1;
    }
    return count;
  }, [mergedWikis, wikiStats, wikiEditCounts]);

  const registrationDate = useMemo(() => {
    if (globalInfo?.registration) return formatDate(globalInfo.registration);
    // fallback: earliest registration date from local user infos
    let earliest = null;
    Object.values(wikiStats).forEach((v) => {
      if (v.userInfo && !v.userInfo.missing && v.userInfo.registration) {
        const d = new Date(v.userInfo.registration);
        if (!earliest || d < earliest) earliest = d;
      }
    });
    return earliest ? formatDate(earliest) : '—';
  }, [globalInfo, wikiStats]);

  // Combine all contributions into a single array with wiki metadata
  const allContributions = useMemo(() => {
    const list = [];
    Object.entries(wikiStats).forEach(([wikiId, data]) => {
      const wiki = WIKIS.find((w) => w.id === wikiId);
      if (!wiki) return;
      (data.contributions || []).forEach((c) => {
        list.push({
          ...c,
          wikiId,
          wikiName: wiki.name,
          wikiColor: wiki.color,
        });
      });
    });
    return list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }, [wikiStats]);

  // Edits per month (recent trend). We only have the last 500 per wiki,
  // so this is the recent activity window, not all-time.
  const monthlyEdits = useMemo(() => {
    const map = {};
    allContributions.forEach((c) => {
      const key = monthKey(c.timestamp);
      map[key] = (map[key] || 0) + 1;
    });
    return Object.entries(map)
      .map(([month, edits]) => ({ month, edits }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [allContributions]);

  // Namespace distribution on recent edits
  const namespaceDistribution = useMemo(() => {
    const map = {};
    allContributions.forEach((c) => {
      const ns = c.ns ?? 0;
      map[ns] = (map[ns] || 0) + 1;
    });
    return Object.entries(map)
      .map(([ns, count]) => ({ ns: Number(ns), name: nsName(Number(ns)), count }))
      .sort((a, b) => b.count - a.count);
  }, [allContributions]);

  // Top edited pages (by frequency)
  const topPages = useMemo(() => {
    const map = {};
    allContributions.forEach((c) => {
      const key = `${c.wikiName}:${c.title}`;
      map[key] = (map[key] || 0) + 1;
    });
    return Object.entries(map)
      .map(([key, count]) => {
        const [wikiName, ...titleParts] = key.split(':');
        return { wikiName, title: titleParts.join(':'), count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [allContributions]);

  // Bytes added/removed over recent contributions
  const bytesAdded = useMemo(
    () => allContributions.reduce((sum, c) => sum + Math.max(0, c.sizediff || 0), 0),
    [allContributions],
  );
  const bytesRemoved = useMemo(
    () => allContributions.reduce((sum, c) => sum + Math.max(0, -(c.sizediff || 0)), 0),
    [allContributions],
  );

  // Derived stats from recent contributions only (last 500 per wiki).
  // Note: article edits exclude Wikidata contributions (ns===0 on Wikidata
  // represents items, not article pages).
  const articleEdits = useMemo(
    () => allContributions.filter((c) => c.wikiId !== 'wikidatawiki' && Number(c.ns ?? 0) === 0).length,
    [allContributions],
  );
  const articleCreations = useMemo(
    () => allContributions.filter((c) => c.wikiId !== 'wikidatawiki' && Number(c.ns ?? 0) === 0 && Array.isArray(c.flags) && c.flags.includes('new')).length,
    [allContributions],
  );
  const wikidataEdits = useMemo(
    () => allContributions.filter((c) => c.wikiId === 'wikidatawiki').length,
    [allContributions],
  );
  const wikidataItemsCreated = useMemo(
    () => allContributions.filter((c) => c.wikiId === 'wikidatawiki' && Number(c.ns ?? 0) === 0 && Array.isArray(c.flags) && c.flags.includes('new')).length,
    [allContributions],
  );
  const uniqueWikidataPages = useMemo(
    () => new Set(allContributions.filter((c) => c.wikiId === 'wikidatawiki' && Number(c.ns ?? 0) === 0).map((c) => c.title)).size,
    [allContributions],
  );

  const hasData = totalEdits > 0 || allContributions.length > 0;

  return (
    <div className="relative min-h-screen bg-background text-primary font-mono">
      <MatrixRain opacity={0.04} />
      <div className="relative z-10 max-w-5xl mx-auto px-4 py-8 md:px-6 md:py-12 safe-top">
        {/* Header */}
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-primary/60 hover:text-primary text-sm mb-6 transition-colors"
        >
          <ArrowLeft size={14} /> BACK
        </Link>

        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <h1 className="text-2xl md:text-3xl font-display tracking-widest neon-glow text-heading">
            ALICEINTHEALICE
          </h1>
          <span className="text-xs text-primary/60 border border-primary/30 px-2 py-0.5">
            LIVE EDITOR REPORT
          </span>
        </div>
        <p className="text-primary/60 text-sm mb-4">
          Everything this page shows is pulled live from Wikimedia&#39;s public APIs.
          Hover any chart for exact numbers. Last updated:{' '}
          {lastUpdated ? new Date(lastUpdated).toLocaleString() : '—'}
        </p>

        {/* Error banner */}
        {error && (
          <div className="border border-danger/40 bg-danger/5 text-danger px-4 py-3 mb-6 flex items-center gap-2">
            <AlertTriangle size={16} />
            <div>
              <p className="text-sm">{error}</p>
              <button
                onClick={() => setRetryTrigger((t) => t + 1)}
                className="mt-2 inline-flex items-center gap-1 text-xs underline hover:text-white"
              >
                <RefreshCw size={12} /> RETRY
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-primary/60 text-sm py-20 justify-center">
            <Loader2 size={18} className="animate-spin" /> Loading Wikimedia data...
          </div>
        ) : !hasData ? (
          <div className="text-center py-16 text-primary/50">
            No data could be loaded. Please try again later.
          </div>
        ) : (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">TOTAL EDITS</p>
                <p className="text-2xl text-primary neon-glow">{formatNumber(totalEdits)}</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">ACTIVE WIKIS</p>
                <p className="text-2xl text-primary neon-glow">{activeWikis}</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">REGISTERED</p>
                <p className="text-2xl text-primary neon-glow">{registrationDate}</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">RECENT EDITS</p>
                <p className="text-2xl text-primary neon-glow">{formatNumber(allContributions.length)}</p>
                <p className="text-[10px] text-primary/40">last {CONTRIB_LIMIT} per wiki</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">RECENT ARTICLE EDITS</p>
                <p className="text-2xl text-primary neon-glow">{formatNumber(articleEdits)}</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">RECENT ARTICLE CREATIONS</p>
                <p className="text-2xl text-primary neon-glow">{formatNumber(articleCreations)}</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">RECENT WIKIDATA EDITS</p>
                <p className="text-2xl text-primary neon-glow">{formatNumber(wikidataEdits)}</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">RECENT WIKIDATA ITEMS CREATED</p>
                <p className="text-2xl text-primary neon-glow">{formatNumber(wikidataItemsCreated)}</p>
              </div>
            </div>

            {/* Per-wiki breakdown */}
            <div className="mb-8">
              <h2 className="text-lg font-display tracking-widest text-primary neon-glow mb-3">
                EDITS BY WIKI
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {WIKIS.map((wiki) => {
                  const count = wikiEditCounts[wiki.id] || 0;
                  const wikiError = wikiStats?.[wiki.id]?.error;
                  return (
                    <div
                      key={wiki.id}
                      className="flex items-center justify-between border border-primary/20 bg-primary/5 px-3 py-2 rounded"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block w-2 h-2 rounded-full"
                          style={{ backgroundColor: wiki.color }}
                        />
                        <span className="text-xs text-primary/80">{wiki.name}</span>
                        {wikiError && (
                          <span className="text-[10px] text-warning" title={wikiError}>
                            ⚠
                          </span>
                        )}
                      </div>
                      <span className="text-sm text-primary font-bold">{formatNumber(count)}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-primary/40 mt-2">
                Counts come from each wiki&#39;s own user info. If a wiki could not be
                reached, its contribution count is shown instead.
              </p>
            </div>

            {/* Monthly trend */}
            {monthlyEdits.length > 0 && (
              <div className="mb-8">
                <h2 className="text-lg font-display tracking-widest text-primary neon-glow mb-2">
                  RECENT EDIT ACTIVITY
                </h2>
                <p className="text-xs text-primary/50 mb-3">
                  Number of edits per month, based on the most recent {CONTRIB_LIMIT}{' '}
                  edits from each wiki. This reflects her current pace, not her full
                  history.
                </p>
                <div className="border border-primary/20 bg-background/50 p-3 rounded">
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={monthlyEdits}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2a1f" />
                      <XAxis
                        dataKey="month"
                        tickFormatter={monthLabel}
                        tick={{ fontSize: 11, fill: '#8f9f8f' }}
                      />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#8f9f8f' }} />
                      <Tooltip
                        labelFormatter={(label) => monthLabel(label)}
                        contentStyle={{
                          backgroundColor: '#0a0f0a',
                          border: '1px solid #39ff14',
                          fontSize: '12px',
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="edits"
                        stroke="#39ff14"
                        strokeWidth={2}
                        dot={{ fill: '#39ff14', r: 3 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Namespace + bytes */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              {namespaceDistribution.length > 0 && (
                <div>
                  <h2 className="text-lg font-display tracking-widest text-primary neon-glow mb-2">
                    WHERE SHE EDITS
                  </h2>
                  <p className="text-xs text-primary/50 mb-3">
                    Namespace distribution of her recent edits. Main = article
                    content, User = user pages, Talk = discussions, etc.
                  </p>
                  <div className="border border-primary/20 bg-background/50 p-3 rounded">
                    <ResponsiveContainer width="100%" height={280}>
                      <PieChart>
                        <Pie
                          data={namespaceDistribution}
                          dataKey="count"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={90}
                          label={(entry) => `${entry.name}: ${entry.count}`}
                          labelLine={false}
                        >
                          {namespaceDistribution.map((entry, i) => (
                            <Cell key={i} fill={entry.color || ['#39ff14', '#00e5ff', '#ffd700', '#ff9f40'][i % 4]} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value, name) => [`${value} edits`, name]}
                          contentStyle={{
                            backgroundColor: '#0a0f0a',
                            border: '1px solid #39ff14',
                            fontSize: '12px',
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              <div>
                <h2 className="text-lg font-display tracking-widest text-primary neon-glow mb-2">
                  BYTES MOVED
                </h2>
                <p className="text-xs text-primary/50 mb-3">
                  Net change (added vs removed) across all recent edits. Positive
                  means she&#39;s expanding content; negative means condensing.
                </p>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="border border-success/30 bg-success/5 p-4 rounded text-center">
                    <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">ADDED</p>
                    <p className="text-xl text-success">+{formatNumber(bytesAdded)}</p>
                  </div>
                  <div className="border border-danger/30 bg-danger/5 p-4 rounded text-center">
                    <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">REMOVED</p>
                    <p className="text-xl text-danger">-{formatNumber(bytesRemoved)}</p>
                  </div>
                </div>
                <div className="border border-primary/20 bg-background/50 p-3 rounded">
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={[{ name: 'Added', value: bytesAdded }, { name: 'Removed', value: bytesRemoved }]}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2a1f" />
                      <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#8f9f8f' }} />
                      <YAxis tick={{ fontSize: 11, fill: '#8f9f8f' }} />
                      <Tooltip
                        cursor={{ fill: 'rgba(57,255,20,0.1)' }}
                        contentStyle={{
                          backgroundColor: '#0a0f0a',
                          border: '1px solid #39ff14',
                          fontSize: '12px',
                        }}
                      />
                      <Bar dataKey="value" fill="#39ff14" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Wikidata contributions */}
            <div className="mb-8">
              <h2 className="text-lg font-display tracking-widest text-primary neon-glow mb-2">
                WIKIDATA CONTRIBUTIONS
              </h2>
              <p className="text-xs text-primary/50 mb-3">
                Alice also contributes directly to Wikidata — the structured data
                behind Wikipedia. This counts her item and property edits in the
                recent {CONTRIB_LIMIT} contributions fetched from Wikidata.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                  <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">RECENT WIKIDATA EDITS</p>
                  <p className="text-xl text-primary neon-glow">{formatNumber(wikidataEdits)}</p>
                </div>
                <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                  <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">RECENT ITEMS CREATED</p>
                  <p className="text-xl text-primary neon-glow">{formatNumber(wikidataItemsCreated)}</p>
                </div>
                <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                  <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">RECENT UNIQUE ITEMS TOUCHED</p>
                  <p className="text-xl text-primary neon-glow">{formatNumber(uniqueWikidataPages)}</p>
                </div>
              </div>
            </div>

            {/* Top pages */}
            {topPages.length > 0 && (
              <div className="mb-8">
                <h2 className="text-lg font-display tracking-widest text-primary neon-glow mb-2">
                  MOST-EDITED PAGES (RECENT)
                </h2>
                <p className="text-xs text-primary/50 mb-3">
                  The pages she has touched most often in the last {CONTRIB_LIMIT}{' '}
                  edits per wiki. Titles are prefixed with the wiki name.
                </p>
                <div className="border border-primary/20 bg-background/50 p-3 rounded overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-primary/50 border-b border-primary/20">
                        <th className="text-left py-2 px-2 font-normal">PAGE</th>
                        <th className="text-right py-2 px-2 font-normal">EDITS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topPages.map((p, idx) => (
                        <tr key={idx} className="border-b border-primary/10 last:border-0">
                          <td className="py-2 px-2 text-primary/80">{p.wikiName}:{p.title}</td>
                          <td className="py-2 px-2 text-right text-primary">{p.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* About Alice */}
            <div className="mb-8">
              <h2 className="text-lg font-display tracking-widest text-primary neon-glow mb-2">
                ABOUT ALICE
              </h2>
              <p className="text-sm text-primary/70 leading-relaxed">
                Alice — known as <span className="text-primary">Aliceinthealice</span> on
                Meta and English Wikipedia and <span className="text-primary">Alice_Woods</span>{' '}
                on Wikimedia Australia — is a dedicated Wikimedia editor whose work spans
                multiple projects. She builds and maintains article content, creates new
                articles from scratch, and dives into Wikidata to keep structured data
                connected and current. Her contributions reflect real knowledge work:
                careful research, clear writing, and a commitment to the open web. For a
                deeper look at her activity, explore her user pages and live contribution
                history below.
              </p>
            </div>

            {/* Source links */}
            <div className="mb-8">
              <h2 className="text-lg font-display tracking-widest text-primary neon-glow mb-2">
                SOURCES
              </h2>
              <ul className="space-y-2 text-sm">
                <li>
                  <a
                    href="https://meta.wikimedia.org/wiki/User:Aliceinthealice"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary/70 hover:text-primary underline"
                  >
                    Meta-Wiki user page <ExternalLink size={12} />
                  </a>
                </li>
                <li>
                  <a
                    href="https://wikimedia.org.au/wiki/User:Alice_Woods"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary/70 hover:text-primary underline"
                  >
                    Wikimedia Australia user page <ExternalLink size={12} />
                  </a>
                </li>
                <li>
                  <a
                    href="https://guc.toolforge.org/?user=Aliceinthealice"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary/70 hover:text-primary underline"
                  >
                    Global account contributions <ExternalLink size={12} />
                  </a>
                </li>
              </ul>
            </div>

            {/* Footer note */}
            <p className="text-[10px] text-primary/30 mt-8 border-t border-primary/10 pt-4">
              Data fetched at {lastUpdated ? new Date(lastUpdated).toLocaleString() : '—'}. All
              numbers are live from Wikimedia APIs and may change as she edits.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
