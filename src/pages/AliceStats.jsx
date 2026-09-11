import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Loader2, ExternalLink, Info } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';

const ARTICLE_TITLE = 'Alice Woods';
const PAGEVIEWS_DAYS = 30;

function formatDateForApi(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}00`;
}

async function fetchWikipediaSummary() {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(ARTICLE_TITLE)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikipedia summary failed: ${res.status}`);
  const data = await res.json();
  if (!data || data.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') {
    throw new Error('Wikipedia article not found.');
  }
  return data;
}

async function fetchPageviews() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - PAGEVIEWS_DAYS);
  const startStr = formatDateForApi(start);
  const endStr = formatDateForApi(end);
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(ARTICLE_TITLE)}/daily/${startStr}/${endStr}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pageviews failed: ${res.status}`);
  const data = await res.json();
  if (!data.items || data.items.length === 0) throw new Error('No pageviews data found.');
  return data.items;
}

async function fetchWikidata() {
  // Get QID from Wikipedia page props
  const wikiPropsUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item&titles=${encodeURIComponent(ARTICLE_TITLE)}&format=json&origin=*`;
  const wikiRes = await fetch(wikiPropsUrl);
  if (!wikiRes.ok) throw new Error(`Wikipedia props failed: ${wikiRes.status}`);
  const wikiData = await wikiRes.json();
  const pages = wikiData?.query?.pages;
  if (!pages) throw new Error('No page found.');
  const page = Object.values(pages)[0];
  const qid = page?.pageprops?.wikibase_item;
  if (!qid) throw new Error('No Wikidata QID found.');

  // Fetch entity data
  const wdUrl = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
  const wdRes = await fetch(wdUrl);
  if (!wdRes.ok) throw new Error(`Wikidata failed: ${wdRes.status}`);
  const wdData = await wdRes.json();
  const entity = wdData?.entities?.[qid];
  if (!entity) throw new Error('Wikidata entity not found.');
  return { qid, entity };
}

export default function AliceStats() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [wikipedia, setWikipedia] = useState(null);
  const [pageviews, setPageviews] = useState(null);
  const [wikidata, setWikidata] = useState(null);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const [wikiResult, pvResult, wdResult] = await Promise.allSettled([
        fetchWikipediaSummary(),
        fetchPageviews(),
        fetchWikidata(),
      ]);

      if (wikiResult.status === 'fulfilled') {
        setWikipedia(wikiResult.value);
      } else {
        setWikipedia(null);
        console.warn('Wikipedia summary error', wikiResult.reason);
      }

      if (pvResult.status === 'fulfilled') {
        setPageviews(pvResult.value);
      } else {
        setPageviews(null);
        console.warn('Pageviews error', pvResult.reason);
      }

      if (wdResult.status === 'fulfilled') {
        setWikidata(wdResult.value);
      } else {
        setWikidata(null);
        console.warn('Wikidata error', wdResult.reason);
      }

      if (
        wikiResult.status === 'rejected' &&
        pvResult.status === 'rejected' &&
        wdResult.status === 'rejected'
      ) {
        setError('All data feeds failed to load. Check the console for details or retry.');
      }
    } catch (e) {
      setError(e.message || 'An unexpected error occurred.');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Derived data for pageviews chart
  const pageviewsChartData = (pageviews || []).map((item) => ({
    date: item.timestamp.slice(0, 8),
    views: item.views,
    label: `${item.timestamp.slice(6, 8)}/${item.timestamp.slice(4, 6)}`,
  }));
  const totalPageviews = pageviewsChartData.reduce((sum, d) => sum + d.views, 0);
  const avgPageviews = pageviewsChartData.length > 0 ? (totalPageviews / pageviewsChartData.length).toFixed(0) : 0;

  // Derived data for Wikidata chart
  const wikidataClaims = wikidata?.entity?.claims || {};
  const totalStatements = Object.values(wikidataClaims).reduce((sum, arr) => sum + arr.length, 0);
  const propertyCounts = Object.entries(wikidataClaims)
    .map(([prop, arr]) => ({ property: prop, count: arr.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(ARTICLE_TITLE)}`;
  const wikidataUrl = wikidata ? `https://www.wikidata.org/wiki/${wikidata.qid}` : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background text-primary font-mono">
        <div className="flex items-center gap-3">
          <Loader2 size={24} className="animate-spin" />
          <span className="text-sm tracking-wider">LOADING ALICE WOODS DATA...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-background text-primary font-mono">
      <div className="relative z-10 max-w-4xl mx-auto px-6 py-12 safe-top">
        <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl md:text-3xl font-display tracking-widest neon-glow text-heading">ALICE WOODS STATS</h1>
            <span className="text-xs text-primary/50 uppercase border border-primary/30 px-2 py-0.5">LIVE</span>
          </div>
          <button
            onClick={fetchAll}
            disabled={refreshing}
            className="flex items-center gap-2 border border-primary/30 hover:border-primary/60 hover:bg-primary/5 transition-colors px-3 py-1.5 text-xs text-primary/70 hover:text-primary disabled:opacity-40"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'REFRESHING...' : 'REFRESH'}
          </button>
        </div>

        <p className="text-primary/60 text-sm mb-8">
          // Live data pulled directly from Wikimedia APIs: Wikipedia summary, pageviews (last 30 days), and Wikidata statements.
          Numbers update in real time and are not cached.
        </p>

        {error && (
          <div className="border border-red-500/30 bg-red-500/5 px-4 py-3 mb-8 text-red-400 text-sm">
            // {error}
          </div>
        )}

        {/* Wikipedia Summary */}
        <section className="mb-8 border border-primary/30 p-5">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-sm font-display tracking-wider text-primary">WIKIPEDIA SUMMARY</h2>
            <a
              href={wikipediaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary/50 hover:text-primary transition-colors"
            >
              <ExternalLink size={14} />
            </a>
          </div>
          <p className="text-xs text-primary/50 mb-4">
            // This is the opening extract from the English Wikipedia article for "{ARTICLE_TITLE}". It provides the most
            reliable, human-reviewed overview of the subject. Below it, the pageviews and Wikidata sections give
            quantitative context.
          </p>
          {wikipedia ? (
            <>
              <h3 className="text-lg font-display text-primary mb-2">{wikipedia.title}</h3>
              {wikipedia.extract && (
                <p className="text-sm text-primary/80 leading-relaxed mb-4">{wikipedia.extract}</p>
              )}
              {wikipedia.thumbnail?.source && (
                <img
                  src={wikipedia.thumbnail.source}
                  alt={wikipedia.title}
                  className="max-w-full h-auto border border-primary/30 mb-4"
                />
              )}
              <div className="flex items-center gap-2 text-xs text-primary/60">
                <span>Last edited: {wikipedia.timestamp ? new Date(wikipedia.timestamp).toLocaleDateString() : 'unknown'}</span>
                <span className="text-primary/30">|</span>
                <span>From Wikipedia, the free encyclopedia</span>
              </div>
            </>
          ) : (
            <p className="text-primary/50 italic text-sm">// Wikipedia summary could not be loaded.</p>
          )}
        </section>

        {/* Pageviews Chart */}
        <section className="mb-8 border border-primary/30 p-5">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-sm font-display tracking-wider text-primary">PAGEVIEWS (LAST {PAGEVIEWS_DAYS} DAYS)</h2>
            <Info size={14} className="text-primary/50" />
          </div>
          <p className="text-xs text-primary/50 mb-4">
            // Total daily pageviews for the Wikipedia article over the last {PAGEVIEWS_DAYS} days, pulled from the
            Wikimedia Pageviews API. The total is the sum of all daily views; the average is total divided by the number
            of days. The chart shows each day's view count. Numbers can fluctuate due to news events, trends, and
            external links.
          </p>
          {pageviews && pageviewsChartData.length > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-3 mb-6">
                <div className="border border-primary/20 p-3">
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-1">Total Views (30d)</div>
                  <div className="text-2xl text-primary font-display">{totalPageviews.toLocaleString()}</div>
                </div>
                <div className="border border-primary/20 p-3">
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-1">Avg Daily Views</div>
                  <div className="text-2xl text-primary font-display">{avgPageviews.toLocaleString()}</div>
                </div>
              </div>
              <div className="h-72 mb-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={pageviewsChartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(var(--primary),0.15)" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: 'rgba(var(--primary),0.6)' }}
                      interval="preserveStartEnd"
                    />
                    <YAxis tick={{ fontSize: 10, fill: 'rgba(var(--primary),0.6)' }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'rgba(0,0,0,0.9)',
                        border: '1px solid rgba(var(--primary),0.3)',
                        borderRadius: 0,
                        color: 'hsl(var(--primary))',
                        fontSize: 12,
                      }}
                      formatter={(value) => [`${value.toLocaleString()} views`, '']}
                    />
                    <Bar dataKey="views" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="text-[10px] text-primary/45">
                // Source: https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/{ARTICLE_TITLE}/daily/
              </p>
            </>
          ) : (
            <p className="text-primary/50 italic text-sm">// Pageviews data could not be loaded.</p>
          )}
        </section>

        {/* Wikidata Statements */}
        <section className="border border-primary/30 p-5">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-sm font-display tracking-wider text-primary">WIKIDATA STATEMENTS</h2>
            {wikidataUrl && (
              <a
                href={wikidataUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary/50 hover:text-primary transition-colors"
              >
                <ExternalLink size={14} />
              </a>
            )}
          </div>
          <p className="text-xs text-primary/50 mb-4">
            // Wikidata represents facts as "statements". Each statement is one claim about the subject (e.g., date of
            birth, occupation). The total number of statements is the sum of all claims on the Wikidata item for "{ARTICLE_TITLE}".
            The chart below shows the top 10 properties by number of claims. Property IDs (e.g., P31 = instance of) are
            standard Wikidata identifiers.
          </p>
          {wikidata && totalStatements > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-3 mb-6">
                <div className="border border-primary/20 p-3">
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-1">Total Statements</div>
                  <div className="text-2xl text-primary font-display">{totalStatements.toLocaleString()}</div>
                </div>
                <div className="border border-primary/20 p-3">
                  <div className="text-xs text-primary/50 uppercase tracking-wider mb-1">Entity QID</div>
                  <div className="text-2xl text-primary font-display">{wikidata.qid}</div>
                </div>
              </div>
              {propertyCounts.length > 0 && (
                <div className="h-64 mb-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={propertyCounts} layout="vertical" margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(var(--primary),0.15)" />
                      <XAxis type="number" tick={{ fontSize: 10, fill: 'rgba(var(--primary),0.6)' }} />
                      <YAxis
                        type="category"
                        dataKey="property"
                        tick={{ fontSize: 10, fill: 'rgba(var(--primary),0.6)' }}
                        width={60}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'rgba(0,0,0,0.9)',
                          border: '1px solid rgba(var(--primary),0.3)',
                          borderRadius: 0,
                          color: 'hsl(var(--primary))',
                          fontSize: 12,
                        }}
                        formatter={(value) => [`${value} statements`, '']}
                      />
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 2, 2, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <p className="text-[10px] text-primary/45">
                // Source: Wikidata entity {wikidata.qid} — https://www.wikidata.org/wiki/{wikidata.qid}
              </p>
            </>
          ) : (
            <p className="text-primary/50 italic text-sm">// Wikidata data could not be loaded.</p>
          )}
        </section>
      </div>
    </div>
  );
}
