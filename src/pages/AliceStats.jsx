import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line, Legend,
} from 'recharts';
import { base44 } from '@/api/base44Client';
import MatrixRain from '@/components/matrix/MatrixRain';

// Aliceinthealice Highlights (Rob, 2026-09-09) — admin-gated stats page for
// one named person. Backed by server/src/functions/getAliceStats.js, which
// aggregates Wikipedia contributions, the Wikidata entity for Alice Woods,
// and pageviews on articles she has created. No database involvement —
// stateless aggregation with an in-memory 15-minute TTL cache server-side.
// The route is protected by the existing adminOnly guard in src/App.jsx.
export default function AliceStats() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('getAliceStats');
      setData(res.data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Convert the per-article pageview series into a single array of
  // { date, [articleTitle]: views } so a multi-line LineChart can render
  // every article on one shared date axis.
  const pageviewSeries = useMemo(() => {
    if (!data?.pageviews?.articles?.length) return [];
    const articles = data.pageviews.articles;
    const dateMap = new Map();
    articles.forEach((article) => {
      article.series?.forEach((point) => {
        if (!dateMap.has(point.date)) dateMap.set(point.date, { date: point.date });
        dateMap.get(point.date)[article.title] = point.views;
      });
    });
    return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  const wikidataPie = useMemo(() => {
    if (!data?.wikidata?.claimsByProperty) return [];
    return data.wikidata.claimsByProperty.map((item) => ({
      name: item.label || item.property,
      value: item.count,
    }));
  }, [data]);

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="border border-red-500/30 px-4 py-3 text-red-500 text-sm max-w-lg w-full">
          {error}
          <button onClick={load} className="block mt-3 text-primary/70 hover:text-primary text-xs">
            RETRY
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-background text-primary font-mono">
      <MatrixRain opacity={0.04} />
      <div className="relative z-10 max-w-6xl mx-auto px-6 py-12 safe-top">
        <div className="flex items-center justify-between mb-8 gap-3 flex-wrap">
          <Link to="/admin" className="inline-flex items-center gap-1.5 text-primary/60 hover:text-primary text-sm transition-colors">
            <ArrowLeft size={14} /> BACK TO ADMIN
          </Link>
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 text-primary/60 hover:text-primary text-sm border border-primary/30 hover:border-primary/60 px-3 py-1.5 transition-colors"
            title="Refresh from Wikimedia APIs"
          >
            <RefreshCw size={13} /> REFRESH
          </button>
        </div>

        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-display tracking-widest neon-glow text-heading">
            ALICEINTHEALICE HIGHLIGHTS
          </h1>
          <p className="text-primary/60 text-sm mt-2">
            // Public Wikipedia, Wikidata, and pageview data — fetched live, cached 15 minutes.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
          <div className="border border-primary/20 bg-primary/5 p-4">
            <div className="text-xs text-primary/60 mb-1 tracking-wider">TOTAL EDITS</div>
            <div className="text-3xl font-display">{data.editCount ?? '—'}</div>
          </div>
          <div className="border border-primary/20 bg-primary/5 p-4">
            <div className="text-xs text-primary/60 mb-1 tracking-wider">REGISTERED SINCE</div>
            <div className="text-xl font-display">
              {data.registration ? new Date(data.registration).toLocaleDateString() : '—'}
            </div>
          </div>
        </div>

        {data.editActivity?.length > 0 && (
          <div className="mb-8 border border-primary/20 bg-primary/5 p-4">
            <h3 className="text-sm text-primary/80 mb-3 tracking-wider">EDIT ACTIVITY OVER TIME</h3>
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.editActivity} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="editGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#34d399" stopOpacity={0.8} />
                      <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(52,211,153,0.15)" />
                  <XAxis dataKey="date" tickFormatter={(d) => d?.slice(5) ?? d} stroke="rgba(52,211,153,0.5)" fontSize={11} />
                  <YAxis stroke="rgba(52,211,153,0.5)" fontSize={11} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: '#0a0f0a', border: '1px solid rgba(52,211,153,0.3)', color: '#d1fae5' }}
                    labelFormatter={(l) => l}
                  />
                  <Area type="monotone" dataKey="count" stroke="#34d399" fill="url(#editGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {data.topEditedPages?.length > 0 && (
          <div className="mb-8 border border-primary/20 bg-primary/5 p-4">
            <h3 className="text-sm text-primary/80 mb-3 tracking-wider">TOP EDITED PAGES</h3>
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.topEditedPages} layout="vertical" margin={{ top: 10, right: 20, left: 20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(52,211,153,0.15)" />
                  <XAxis type="number" stroke="rgba(52,211,153,0.5)" fontSize={11} allowDecimals={false} />
                  <YAxis type="category" dataKey="title" stroke="rgba(52,211,153,0.5)" fontSize={10} width={160} />
                  <Tooltip contentStyle={{ background: '#0a0f0a', border: '1px solid rgba(52,211,153,0.3)', color: '#d1fae5' }} />
                  <Bar dataKey="count" fill="#4ade80" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {wikidataPie.length > 0 && (
          <div className="mb-8 border border-primary/20 bg-primary/5 p-4">
            <h3 className="text-sm text-primary/80 mb-3 tracking-wider">
              WIKIDATA ENTITY: {data.wikidata?.label || 'Alice Woods'}{data.wikidata?.id ? ` (${data.wikidata.id})` : ''}
            </h3>
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={wikidataPie}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    fill="#34d399"
                    label={(entry) => entry.name}
                  >
                    {wikidataPie.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={['#34d399', '#4ade80', '#a3e635', '#2dd4bf', '#22d3ee', '#818cf8', '#e879f9'][index % 7]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: '#0a0f0a', border: '1px solid rgba(52,211,153,0.3)', color: '#d1fae5' }} />
                  <Legend wrapperStyle={{ color: 'rgba(52,211,153,0.7)' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {pageviewSeries.length > 0 && (
          <div className="mb-8 border border-primary/20 bg-primary/5 p-4">
            <h3 className="text-sm text-primary/80 mb-3 tracking-wider">PAGEVIEWS ON NEW ARTICLES</h3>
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={pageviewSeries} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(52,211,153,0.15)" />
                  <XAxis dataKey="date" tickFormatter={(d) => d?.slice(5) ?? d} stroke="rgba(52,211,153,0.5)" fontSize={11} />
                  <YAxis stroke="rgba(52,211,153,0.5)" fontSize={11} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: '#0a0f0a', border: '1px solid rgba(52,211,153,0.3)', color: '#d1fae5' }} />
                  <Legend wrapperStyle={{ color: 'rgba(52,211,153,0.7)' }} />
                  {data.pageviews?.articles?.map((article, idx) => (
                    <Line
                      key={article.title}
                      type="monotone"
                      dataKey={article.title}
                      stroke={['#34d399', '#4ade80', '#a3e635', '#2dd4bf', '#22d3ee'][idx % 5]}
                      strokeWidth={2}
                      dot={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {!data.editActivity?.length && !data.topEditedPages?.length && !wikidataPie.length && !pageviewSeries.length && (
          <div className="text-primary/40 text-sm italic py-12 text-center border border-primary/20">
            No data returned from Wikimedia APIs. Try again shortly.
          </div>
        )}
      </div>
    </div>
  );
}
