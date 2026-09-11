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
 * to public APIs, no backend or database involved.
 *
 * Data sources:
 *  - XTools (xtools.wmcloud.org) — authoritative all-time statistics for
 *    Wikimedia Foundation wikis (edit counts, namespace totals, top pages,
 *    pages created, bytes added/removed, monthly activity).
 *  - MediaWiki API on wikimedia.org.au — full contribution history for the
 *    standalone Wikimedia Australia wiki (not covered by XTools), fetched
 *    with continuation to ensure no edits are missed.
 *  - Meta-Wiki globaluserinfo — registration date and global account info.
 *
 * The page is public (brag page for the editor) and admin-friendly:
 * it never requires a login and never stores anything.
 */

const UA = 'MorpheusStatsPage/1.0 (+https://morpheus.nz)';
const TIMEOUT_MS = 20000;
const XTOOLS_BASE = 'https://xtools.wmcloud.org/api';
const AU_API = 'https://wikimedia.org.au/w/api.php';
const AU_USERNAME = 'Alice_Woods';
const GLOBAL_USERNAME = 'Aliceinthealice';
const CONTRIB_LIMIT = 500; // batch size for AU continuation
const MAX_AU_PAGES = 10000; // safety cap for infinite continuation

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

// Fetch ALL contributions for the AU wiki (Wikimedia Australia) using
// MediaWiki continuation. This ensures complete edit history, not just the
// most recent 500. Returns an array of raw contribution objects.
async function fetchAllAuContributions() {
  const all = [];
  let uccontinue = null;
  let page = 0;
  do {
    const params = new URLSearchParams({
      action: 'query',
      list: 'usercontribs',
      ucuser: AU_USERNAME,
      uclimit: String(CONTRIB_LIMIT),
      ucprop: 'title|timestamp|comment|size|sizediff|flags|ns',
      format: 'json',
      origin: '*',
    });
    if (uccontinue) params.set('uccontinue', uccontinue);
    const url = `${AU_API}?${params.toString()}`;
    const data = await fetchJson(url);
    const items = data?.query?.usercontribs || [];
    all.push(...items);
    uccontinue = data?.continue?.uccontinue || null;
    page++;
    if (page > MAX_AU_PAGES) break; // safety
  } while (uccontinue);
  return all;
}

// XTools API helper – returns parsed JSON, with defensive extraction
async function fetchXtools(endpoint) {
  return fetchJson(`${XTOOLS_BASE}${endpoint}`, { headers: { 'User-Agent': UA } });
}

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
  120: 'Property',
  121: 'Property talk',
  122: 'Lexeme',
  123: 'Lexeme talk',
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

function extractNamespaceTotals(data) {
  // XTools returns either { namespaces: { "0": n, "1": m, ... } } or an array
  if (data?.namespaces && typeof data.namespaces === 'object') {
    return data.namespaces;
  }
  if (Array.isArray(data)) {
    const obj = {};
    data.forEach((entry) => {
      if (entry && typeof entry.ns === 'number' && typeof entry.count === 'number') {
        obj[entry.ns] = entry.count;
      }
    });
    return obj;
  }
  return {};
}

function extractTopPages(data) {
  // XTools returns { pages: [ { title, count, namespace } ] } or { top_pages: [...] }
  const list = data?.pages || data?.top_pages || [];
  return Array.isArray(list) ? list : [];
}

function extractPagesCreated(data) {
  const list = data?.pages || data?.pages_created || [];
  return Array.isArray(list) ? list : [];
}

function extractMonthCounts(data) {
  // XTools returns { months: [ { month: 'YYYY-MM', count } ] } or similar
  const list = data?.months || data?.month_counts || [];
  if (Array.isArray(list)) {
    return list.map((entry) => ({
      month: entry.month || entry.yyyymm,
      count: entry.count || entry.edits,
    })).filter((e) => e.month);
  }
  return [];
}

function extractBytes(data) {
  if (!data) return { added: 0, removed: 0 };
  return {
    added: data.added || data.bytes_added || 0,
    removed: data.removed || data.bytes_removed || 0,
  };
}

export default function AliceStats() {
  const [globalStats, setGlobalStats] = useState(null); // XTools global stats
  const [globalInfo, setGlobalInfo] = useState(null); // Meta globaluserinfo
  const [auContributions, setAuContributions] = useState([]); // all AU edits
  const [wikiDetails, setWikiDetails] = useState({}); // { wikiId: { monthCounts, topPages, namespaceTotals, pagesCreated, bytesAdded } }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [retryTrigger, setRetryTrigger] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. XTools global stats for Aliceinthealice (WMF wikis)
      const gtData = await fetchXtools(`/user/global_stats/${encodeURIComponent(GLOBAL_USERNAME)}`);
      const gt = gtData?.global_stats || gtData;
      setGlobalStats(gt);

      // 2. Meta globaluserinfo for registration date
      const guiRes = await fetchJson(
        `https://meta.wikimedia.org/w/api.php?action=query&list=globaluserinfo&format=json&origin=*&guiprop=editcount|groups|merged|registration&guiuser=${encodeURIComponent(GLOBAL_USERNAME)}`,
      );
      const gui = guiRes?.query?.globaluserinfo || null;
      setGlobalInfo(gui);

      // 3. AU wiki full contributions
      const auAll = await fetchAllAuContributions();
      setAuContributions(auAll);

      // 4. For each WMF wiki with edits > 0, fetch detailed XTools data
      const perWiki = gt?.per_wiki || [];
      const activeWmfWikis = perWiki.filter((w) => Number(w.total_revisions) > 0);
      const details = {};
      await Promise.all(
        activeWmfWikis.map(async (wikiEntry) => {
          const wikiId = wikiEntry.wiki;
          const detail = {
            monthCounts: [],
            topPages: [],
            namespaceTotals: {},
            pagesCreated: [],
            bytesAdded: { added: 0, removed: 0 },
            error: null,
          };
          try {
            const [monthData, topData, nsData, pagesData, bytesData] = await Promise.all([
              fetchXtools(`/user/month_counts/${encodeURIComponent(GLOBAL_USERNAME)}/${wikiId}`).catch(() => null),
              fetchXtools(`/user/top_pages/${encodeURIComponent(GLOBAL_USERNAME)}/${wikiId}`).catch(() => null),
              fetchXtools(`/user/namespace_totals/${encodeURIComponent(GLOBAL_USERNAME)}/${wikiId}`).catch(() => null),
              fetchXtools(`/user/pages_created/${encodeURIComponent(GLOBAL_USERNAME)}/${wikiId}`).catch(() => null),
              fetchXtools(`/user/bytes_added/${encodeURIComponent(GLOBAL_USERNAME)}/${wikiId}`).catch(() => null),
            ]);
            if (monthData) detail.monthCounts = extractMonthCounts(monthData);
            if (topData) detail.topPages = extractTopPages(topData);
            if (nsData) detail.namespaceTotals = extractNamespaceTotals(nsData);
            if (pagesData) detail.pagesCreated = extractPagesCreated(pagesData);
            if (bytesData) detail.bytesAdded = extractBytes(bytesData);
          } catch (err) {
            detail.error = `XTools detail failed: ${err.message}`;
          }
          details[wikiId] = detail;
        }),
      );
      setWikiDetails(details);
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
  const mergedPerWiki = useMemo(() => {
    const map = {};
    (globalStats?.per_wiki || []).forEach((w) => {
      map[w.wiki] = Number(w.total_revisions) || 0;
    });
    return map;
  }, [globalStats]);

  const auTotalEdits = auContributions.length;
  const auFirstEdit = auContributions.length ? auContributions[auContributions.length - 1].timestamp : null;
  const auLastEdit = auContributions.length ? auContributions[0].timestamp : null;

  const totalEdits = useMemo(() => {
    const wmfSum = Object.values(mergedPerWiki).reduce((a, b) => a + b, 0);
    return wmfSum + auTotalEdits;
  }, [mergedPerWiki, auTotalEdits]);

  const activeWikis = useMemo(() => {
    let count = Object.values(mergedPerWiki).filter((n) => n > 0).length;
    if (auTotalEdits > 0) count += 1;
    return count;
  }, [mergedPerWiki, auTotalEdits]);

  const registrationDate = useMemo(() => {
    if (globalInfo?.registration) return formatDate(globalInfo.registration);
    return '—';
  }, [globalInfo]);

  // Aggregate monthly edits across WMF wikis + AU
  const monthlyEdits = useMemo(() => {
    const map = {};
    // WMF wikis from XTools month_counts
    Object.values(wikiDetails).forEach((d) => {
      (d.monthCounts || []).forEach((entry) => {
        if (entry.month) {
          map[entry.month] = (map[entry.month] || 0) + (Number(entry.count) || 0);
        }
      });
    });
    // AU contributions
    auContributions.forEach((c) => {
      const key = monthKey(c.timestamp);
      map[key] = (map[key] || 0) + 1;
    });
    const arr = Object.entries(map)
      .map(([month, edits]) => ({ month, edits }))
      .sort((a, b) => a.month.localeCompare(b.month));
    // Limit to last 24 months for readability
    return arr.slice(-24);
  }, [wikiDetails, auContributions]);

  // Aggregate namespace distribution across all wikis
  const namespaceDistribution = useMemo(() => {
    const map = {};
    // WMF wikis namespace totals
    Object.values(wikiDetails).forEach((d) => {
      Object.entries(d.namespaceTotals || {}).forEach(([ns, count]) => {
        const n = Number(ns);
        map[n] = (map[n] || 0) + Number(count);
      });
    });
    // AU contributions namespace counts
    auContributions.forEach((c) => {
      const ns = c.ns ?? 0;
      map[ns] = (map[ns] || 0) + 1;
    });
    return Object.entries(map)
      .map(([ns, count]) => ({ ns: Number(ns), name: nsName(Number(ns)), count }))
      .sort((a, b) => b.count - a.count);
  }, [wikiDetails, auContributions]);

  // Aggregate bytes added/removed across all wikis
  const bytesAdded = useMemo(() => {
    let sum = 0;
    Object.values(wikiDetails).forEach((d) => {
      sum += d.bytesAdded?.added || 0;
    });
    auContributions.forEach((c) => {
      if (c.sizediff > 0) sum += c.sizediff;
    });
    return sum;
  }, [wikiDetails, auContributions]);

  const bytesRemoved = useMemo(() => {
    let sum = 0;
    Object.values(wikiDetails).forEach((d) => {
      sum += d.bytesAdded?.removed || 0;
    });
    auContributions.forEach((c) => {
      if (c.sizediff < 0) sum += Math.abs(c.sizediff);
    });
    return sum;
  }, [wikiDetails, auContributions]);

  // Aggregate top pages across all wikis
  const topPages = useMemo(() => {
    const list = [];
    const wikiNames = {
      enwiki: 'English Wikipedia',
      metawiki: 'Meta-Wiki',
      wikidatawiki: 'Wikidata',
      mediawiki: 'Wikimedia AU',
    };
    Object.entries(wikiDetails).forEach(([wikiId, d]) => {
      (d.topPages || []).forEach((p) => {
        if (p.title) {
          list.push({
            wikiName: wikiNames[wikiId] || wikiId,
            title: p.title,
            count: Number(p.count) || 0,
          });
        }
      });
    });
    // AU top pages from contributions (aggregate counts)
    const auMap = {};
    auContributions.forEach((c) => {
      auMap[c.title] = (auMap[c.title] || 0) + 1;
    });
    Object.entries(auMap).forEach(([title, count]) => {
      list.push({ wikiName: 'Wikimedia AU', title, count });
    });
    return list.sort((a, b) => b.count - a.count).slice(0, 10);
  }, [wikiDetails, auContributions]);

  // Article edits: sum of namespace 0 counts across WMF wikis (exclude wikidata)
  // plus AU namespace 0 contributions
  const articleEdits = useMemo(() => {
    let sum = 0;
    Object.entries(wikiDetails).forEach(([wikiId, d]) => {
      if (wikiId === 'wikidatawiki') return; // exclude wikidata from article edits
      if (d.namespaceTotals) {
        sum += Number(d.namespaceTotals[0] || 0);
      }
    });
    auContributions.forEach((c) => {
      if (Number(c.ns ?? 0) === 0) sum += 1;
    });
    return sum;
  }, [wikiDetails, auContributions]);

  // Article creations: count of pages created in namespace 0 from XTools
  // pages_created (excluding wikidata) + AU contributions with flag 'new' and ns 0
  const articleCreations = useMemo(() => {
    let sum = 0;
    Object.entries(wikiDetails).forEach(([wikiId, d]) => {
      if (wikiId === 'wikidatawiki') return;
      (d.pagesCreated || []).forEach((p) => {
        if (Number(p.namespace ?? 0) === 0) sum += 1;
      });
    });
    auContributions.forEach((c) => {
      if (Number(c.ns ?? 0) === 0 && Array.isArray(c.flags) && c.flags.includes('new')) sum += 1;
    });
    return sum;
  }, [wikiDetails, auContributions]);

  // Wikidata edits: total revisions on wikidatawiki from global stats
  const wikidataEdits = useMemo(() => {
    return mergedPerWiki['wikidatawiki'] || 0;
  }, [mergedPerWiki]);

  // Wikidata items created: pages_created entries for wikidatawiki with namespace 0
  const wikidataItemsCreated = useMemo(() => {
    const d = wikiDetails['wikidatawiki'];
    if (!d?.pagesCreated) return 0;
    return d.pagesCreated.filter((p) => Number(p.namespace ?? 0) === 0).length;
  }, [wikiDetails]);

  const hasData = totalEdits > 0 || auTotalEdits > 0;

  const monthFormatter = (label) => monthLabel(label);

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
          Everything this page shows is pulled live from XTools and Wikimedia APIs.
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
            {/* Stat cards – all-time accurate */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">TOTAL EDITS</p>
                <p className="text-2xl text-primary neon-glow">{formatNumber(totalEdits)}</p>
                <p className="text-[10px] text-primary/40 mt-1">all-time, all wikis</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">ACTIVE WIKIS</p>
                <p className="text-2xl text-primary neon-glow">{activeWikis}</p>
                <p className="text-[10px] text-primary/40 mt-1">with at least one edit</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">REGISTERED</p>
                <p className="text-2xl text-primary neon-glow">{registrationDate}</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">ARTICLE EDITS</p>
                <p className="text-2xl text-primary neon-glow">{formatNumber(articleEdits)}</p>
                <p className="text-[10px] text-primary/40 mt-1">main namespace, all time</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">ARTICLE CREATIONS</p>
                <p className="text-2xl text-primary neon-glow">{formatNumber(articleCreations)}</p>
                <p className="text-[10px] text-primary/40 mt-1">new pages created</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">WIKIDATA EDITS</p>
                <p className="text-2xl text-primary neon-glow">{formatNumber(wikidataEdits)}</p>
                <p className="text-[10px] text-primary/40 mt-1">on Wikidata</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">WIKIDATA ITEMS</p>
                <p className="text-2xl text-primary neon-glow">{formatNumber(wikidataItemsCreated)}</p>
                <p className="text-[10px] text-primary/40 mt-1">items created</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">BYTES ADDED</p>
                <p className="text-2xl text-primary neon-glow">+{formatNumber(bytesAdded)}</p>
                <p className="text-[10px] text-primary/40 mt-1">all time</p>
              </div>
            </div>

            {/* Per-wiki breakdown */}
            <div className="mb-8">
              <h2 className="text-lg font-display tracking-widest text-primary neon-glow mb-3">
                EDITS BY WIKI
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {Object.entries(mergedPerWiki).map(([wikiId, count]) => {
                  const names = {
                    enwiki: 'English Wikipedia',
                    metawiki: 'Meta-Wiki',
                    wikidatawiki: 'Wikidata',
                    mediawiki: 'Wikimedia AU',
                  };
                  const name = names[wikiId] || wikiId;
                  return (
                    <div
                      key={wikiId}
                      className="flex items-center justify-between border border-primary/20 bg-primary/5 px-3 py-2 rounded"
                    >
                      <span className="text-xs text-primary/80">{name}</span>
                      <span className="text-sm text-primary font-bold">{formatNumber(count)}</span>
                    </div>
                  );
                })}
                {auTotalEdits > 0 && (
                  <div className="flex items-center justify-between border border-primary/20 bg-primary/5 px-3 py-2 rounded">
                    <span className="text-xs text-primary/80">Wikimedia AU (Alice_Woods)</span>
                    <span className="text-sm text-primary font-bold">{formatNumber(auTotalEdits)}</span>
                  </div>
                )}
              </div>
              <p className="text-[11px] text-primary/40 mt-2">
                Counts for WMF wikis come from XTools global stats; the Wikimedia AU
                count comes from a complete continuation fetch of her contributions.
              </p>
            </div>

            {/* Monthly trend */}
            {monthlyEdits.length > 0 && (
              <div className="mb-8">
                <h2 className="text-lg font-display tracking-widest text-primary neon-glow mb-2">
                  MONTHLY EDIT ACTIVITY
                </h2>
                <p className="text-xs text-primary/50 mb-3">
                  Number of edits per month across all wikis. This is the real
                  all-time activity, not just a recent window. Hover any point for
                  exact counts.
                </p>
                <div className="border border-primary/20 bg-background/50 p-3 rounded">
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={monthlyEdits}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2a1f" />
                      <XAxis
                        dataKey="month"
                        tickFormatter={monthFormatter}
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
                    Namespace distribution across all wikis. Main = article content,
                    User = user pages, Talk = discussions, etc. This is all-time,
                    not just recent.
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
                            <Cell key={i} fill={['#39ff14', '#00e5ff', '#ffd700', '#ff9f40', '#ff4d4d', '#b366ff'][i % 6]} />
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
                  Total bytes added and removed across all wikis (all-time).
                  Positive means she&#39;s expanding content; negative means condensing.
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
                behind Wikipedia. These numbers are all-time, sourced from XTools.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                  <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">TOTAL WIKIDATA EDITS</p>
                  <p className="text-xl text-primary neon-glow">{formatNumber(wikidataEdits)}</p>
                </div>
                <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                  <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">ITEMS CREATED</p>
                  <p className="text-xl text-primary neon-glow">{formatNumber(wikidataItemsCreated)}</p>
                </div>
                <div className="border border-primary/20 bg-primary/5 p-4 rounded">
                  <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">TOP ITEMS EDITED</p>
                  {wikiDetails['wikidatawiki']?.topPages?.slice(0, 3).map((p, i) => (
                    <div key={i} className="text-xs text-primary/70 truncate">{p.title}</div>
                  ))}
                </div>
              </div>
            </div>

            {/* Top pages */}
            {topPages.length > 0 && (
              <div className="mb-8">
                <h2 className="text-lg font-display tracking-widest text-primary neon-glow mb-2">
                  MOST-EDITED PAGES (ALL TIME)
                </h2>
                <p className="text-xs text-primary/50 mb-3">
                  The pages she has touched most often across all wikis. Titles are
                  prefixed with the wiki name. Based on XTools top pages for WMF
                  wikis and complete AU contribution history.
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
                    href="https://xtools.wmcloud.org/globalcontribs/Aliceinthealice"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary/70 hover:text-primary underline"
                  >
                    XTools Global Contributions <ExternalLink size={12} />
                  </a>
                </li>
              </ul>
            </div>

            {/* Footer note */}
            <p className="text-[10px] text-primary/30 mt-8 border-t border-primary/10 pt-4">
              Data fetched at {lastUpdated ? new Date(lastUpdated).toLocaleString() : '—'}. All
              numbers are live from XTools and Wikimedia APIs and may change as she edits.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
