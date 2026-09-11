import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, AlertTriangle, ExternalLink, RefreshCw, Link as LinkIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend,
  LineChart,
  Line,
} from 'recharts';

const COLORS = ['#39ff14', '#00b4d8', '#f72585', '#ffd166', '#9b5de5', '#fb5607', '#06d6a0'];

function StatCard({ label, value }) {
  return (
    <div className="bg-primary/5 border border-primary/20 p-6 rounded-sm">
      <div className="text-sm text-primary/60 uppercase tracking-wider">{label}</div>
      <div className="text-5xl font-bold text-primary mt-2 neon-glow">{value.toLocaleString()}</div>
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="bg-primary/5 border border-primary/20 p-4 rounded-sm">
      <h3 className="text-sm font-bold text-primary/80 uppercase tracking-wider mb-4">{title}</h3>
      {children}
    </div>
  );
}

function normalizePageviewSeries(pageviewSeries) {
  if (!pageviewSeries) return { dates: [], titles: [], data: [] };
  // Object shape: { dates: [...], series: { title: [...] } } (preferred)
  if (!Array.isArray(pageviewSeries)) {
    const dates = pageviewSeries.dates || [];
    const series = pageviewSeries.series || {};
    const titles = Object.keys(series);
    const data = dates.map((date, i) => {
      const point = { date };
      titles.forEach((title) => {
        point[title] = series[title]?.[i] ?? 0;
      });
      return point;
    });
    return { dates, titles, data };
  }
  // Legacy array shapes: either [{date, titleA, titleB}, ...] or [{title, series:[...]}]
  if (pageviewSeries.length === 0) return { dates: [], titles: [], data: [] };
  // Case 1: array of {title, series} objects
  if (pageviewSeries[0] && 'title' in pageviewSeries[0] && 'series' in pageviewSeries[0]) {
    const dates = pageviewSeries[0].series?.map(d => d.date) || [];
    const series = {};
    pageviewSeries.forEach(({ title, series: daily }) => {
      series[title] = daily?.map(d => d.views ?? 0) || [];
    });
    const titles = Object.keys(series);
    const data = dates.map((date, i) => {
      const point = { date };
      titles.forEach(title => { point[title] = series[title]?.[i] ?? 0; });
      return point;
    });
    return { dates, titles, data };
  }
  // Case 2: array of flat objects with date + title keys
  const titles = Object.keys(pageviewSeries[0]).filter((k) => k !== 'date');
  return { dates: [], titles, data: pageviewSeries };
}

export default function StatsAlice() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('getAliceStats');
      setData(res.data);
    } catch (e) {
      setError(e.message || 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const activityTimeline = data?.activityTimeline || [];
  const topArticles = data?.topArticles || [];
  const propertyDistribution = data?.wikidata?.propertyDistribution || [];
  const notableClaims = data?.wikidata?.notableClaims || [];
  const pageviewNormalized = normalizePageviewSeries(data?.pageviewSeries);

  return (
    <div className="min-h-screen bg-background text-primary font-mono p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-display tracking-wider neon-glow">ALICEINTHEALICE HIGHLIGHTS</h1>
            <p className="text-primary/60 text-sm mt-2">Live stats from Wikipedia and Wikidata</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={fetchStats}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs px-3 h-[36px] border border-primary/30 text-primary/70 hover:text-primary hover:border-primary/60 hover:bg-primary/5 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              {loading ? 'REFRESHING…' : 'REFRESH'}
            </button>
            <Link
              to="/self-dev"
              className="flex items-center gap-1.5 text-xs px-3 h-[36px] border border-primary/30 text-primary/70 hover:text-primary hover:border-primary/60 hover:bg-primary/5 transition-colors"
            >
              <LinkIcon size={13} /> SELF-DEV
            </Link>
          </div>
        </header>

        {loading && (
          <div className="flex items-center justify-center py-24">
            <Loader2 size={32} className="animate-spin text-primary/60" />
          </div>
        )}

        {!loading && error && (
          <div className="border border-red-500/30 bg-red-500/10 p-6 rounded-sm flex flex-col items-center gap-3">
            <AlertTriangle size={24} className="text-red-400" />
            <p className="text-red-400">Failed to load stats: {error}</p>
            <button
              onClick={fetchStats}
              className="text-xs px-3 py-1 border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors"
            >
              TRY AGAIN
            </button>
          </div>
        )}

        {!loading && !error && data && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <StatCard label="Total Wikipedia Edits" value={data.editCount || 0} />
              <StatCard label="Articles Created" value={(data.createdArticles || []).length} />
              <StatCard label="Wikidata Claims" value={propertyDistribution.reduce((sum, p) => sum + (p.count || 0), 0)} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ChartCard title="Edit Activity Timeline">
                {activityTimeline.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={activityTimeline}>
                      <defs>
                        <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#39ff14" stopOpacity={0.8} />
                          <stop offset="95%" stopColor="#39ff14" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#39ff1433" />
                      <XAxis dataKey="month" tick={{ fill: '#39ff14', fontSize: 11 }} />
                      <YAxis tick={{ fill: '#39ff14', fontSize: 11 }} />
                      <Tooltip contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #39ff1455', fontSize: 12 }} />
                      <Area type="monotone" dataKey="count" stroke="#39ff14" fillOpacity={1} fill="url(#colorCount)" />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-primary/40 text-sm">No edit timeline data available.</p>
                )}
              </ChartCard>

              <ChartCard title="Top Edited Articles">
                {topArticles.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={topArticles} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#39ff1433" />
                      <XAxis type="number" tick={{ fill: '#39ff14', fontSize: 11 }} />
                      <YAxis type="category" dataKey="title" width={180} tick={{ fill: '#39ff14', fontSize: 11 }} />
                      <Tooltip contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #39ff1455', fontSize: 12 }} />
                      <Bar dataKey="count" fill="#00b4d8" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-primary/40 text-sm">No top articles data available.</p>
                )}
              </ChartCard>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ChartCard title="Wikidata Property Distribution">
                {propertyDistribution.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={propertyDistribution}
                        dataKey="count"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={90}
                        label={(entry) => entry.name}
                      >
                        {propertyDistribution.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #39ff1455', fontSize: 12 }} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-primary/40 text-sm">No Wikidata property data available.</p>
                )}
              </ChartCard>

              <ChartCard title="Pageviews on Created Articles (60 days)">
                {pageviewNormalized.data.length > 0 && pageviewNormalized.titles.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={pageviewNormalized.data}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#39ff1433" />
                      <XAxis dataKey="date" tick={{ fill: '#39ff14', fontSize: 11 }} />
                      <YAxis tick={{ fill: '#39ff14', fontSize: 11 }} />
                      <Tooltip contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #39ff1455', fontSize: 12 }} />
                      <Legend />
                      {pageviewNormalized.titles.map((title, i) => (
                        <Line
                          key={title}
                          type="monotone"
                          dataKey={title}
                          stroke={COLORS[i % COLORS.length]}
                          dot={false}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-primary/40 text-sm">No pageview data available.</p>
                )}
              </ChartCard>
            </div>

            <ChartCard title="Notable Wikidata Claims">
              {notableClaims.length > 0 ? (
                <ul className="space-y-2">
                  {notableClaims.map((claim, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <ExternalLink size={14} className="text-primary/50 mt-1 shrink-0" />
                      <span>
                        <span className="text-primary/60">{claim.property}:</span> {claim.value}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-primary/40 text-sm">No notable claims available.</p>
              )}
            </ChartCard>
          </div>
        )}
      </div>
    </div>
  );
}
