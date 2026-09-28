// Energy sparkline — the account's own energy log (DeckEnergyLogEntry) drawn
// as a 30-day line.
//
// Why this widget calls its own backend function instead of reading
// CommandDeckContext's `energyHistory`: the context deliberately holds only the
// last 7 days (that is what Today's charge renders), and seven points is a
// shape, not a trend. server/src/functions/widgetEnergySparkline.js reads the
// same entity scoped to the caller's own rows and clamps the window it is asked
// for, so asking for 30 here does not grow a second copy of everyone's history
// into the shared context.
//
// Deliberately independent: nothing imported from another widget, no new token
// in deckConstants.js, no change to DeckUI.jsx. A day with no entry is drawn as
// a GAP, never as "low" — "nothing logged" and "a low day" are different
// answers about a month, and a line that merged the two would be a quiet lie.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { C } from '../deckConstants';
import { Card, EmptyNote, ghostBtn } from '../DeckUI';

const DAYS = 30;

// Same level colours Today's charge already uses for its 7-day dots (low/med/
// high -> C.alert / C.gold / C.sage), so the two widgets read as one system.
const LEVEL_COLOR = { low: C.alert, med: C.gold, high: C.sage };
const LEVEL_LABEL = { low: 'Low', med: 'Medium', high: 'High' };

// Sparkline geometry. A fixed viewBox with a proportional width means the line
// scales with the card instead of needing a measured container.
const W = 300;
const H = 64;
const PAD_X = 6;
const PAD_Y = 8;
const INNER_W = W - PAD_X * 2;
const INNER_H = H - PAD_Y * 2;
const BASELINE = PAD_Y + INNER_H + 4;

const xAt = (i) => PAD_X + (i / (DAYS - 1)) * INNER_W;
const yAt = (v) => PAD_Y + (1 - (v - 1) / 2) * INNER_H;

function levelValue(level) {
  if (level === null || level === undefined) return null;
  if (typeof level === 'number') {
    if (!Number.isFinite(level)) return null;
    return Math.min(3, Math.max(1, Math.round(level)));
  }
  const l = String(level).trim().toLowerCase();
  if (l.startsWith('lo')) return 1;
  if (l.startsWith('h')) return 3;
  if (l.startsWith('me')) return 2;
  return null;
}

// The endpoint's own shape is read defensively — this widget is the only thing
// that would break if it moved, and a shape mismatch must degrade to "no data",
// not to a blank panel with no explanation of why.
function extractEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['entries', 'sparkline', 'energy', 'items', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

// 30 fixed calendar days ending today (UTC, the same midnight-UTC convention
// DeckEnergyLogEntry.date is stored in), each carrying its recorded level or
// null. Building the window here rather than trusting the payload's length is
// what lets an untouched day render as a gap.
function buildWindow(entries) {
  const byDate = {};
  for (const e of entries) {
    const key = String(e && e.date ? e.date : '').slice(0, 10);
    if (key) byDate[key] = e.level;
  }
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const key = new Date(todayUtc - i * 86400000).toISOString().slice(0, 10);
    const raw = byDate[key];
    out.push({ key, value: levelValue(raw), level: raw === undefined ? null : raw });
  }
  return out;
}

export default function EnergySparklineWidget() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('widgetEnergySparkline', { days: DAYS });
      const payload = res && typeof res === 'object' && 'data' in res ? res.data : res;
      setEntries(extractEntries(payload));
    } catch (e) {
      setEntries([]);
      // Fail loud, not silent: an unavailable read shows its reason instead of
      // a flat line that would read as "you have been exhausted for a month".
      setError((e && e.message) || 'the energy log did not answer');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const days = useMemo(() => buildWindow(entries), [entries]);
  const points = useMemo(
    () => days.reduce((acc, d, i) => {
      if (d.value) acc.push({ i, v: d.value, level: d.level, key: d.key });
      return acc;
    }, []),
    [days]
  );

  const logged = points.length;
  const avgValue = logged ? points.reduce((s, p) => s + p.v, 0) / logged : 0;
  const avgLabel = avgValue >= 2.5 ? 'High' : avgValue >= 1.5 ? 'Medium' : 'Low';

  const linePath = points
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${xAt(p.i).toFixed(1)},${yAt(p.v).toFixed(1)}`)
    .join(' ');
  const areaPath = points.length > 1
    ? `${linePath} L${xAt(points[points.length - 1].i).toFixed(1)},${BASELINE} L${xAt(points[0].i).toFixed(1)},${BASELINE} Z`
    : '';
  const lastPoint = points.length ? points[points.length - 1] : null;

  const summary = loading && logged === 0
    ? 'Reading your log…'
    : error
      ? 'Unavailable'
      : logged === 0
        ? `No entries in the last ${DAYS} days`
        : `${logged} of ${DAYS} days logged · average ${avgLabel}`;

  return (
    <Card title="Energy sparkline" sub={`${DAYS}-day rhythm`}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.35rem' }}>
        <span style={{ fontSize: '0.72rem', color: C.walnutSoft }}>{summary}</span>
        <button
          onClick={load}
          disabled={loading}
          title="Re-read the energy log"
          style={{ ...ghostBtn, fontSize: '0.7rem', color: C.brass, display: 'inline-flex', alignItems: 'center', gap: '0.25rem', opacity: loading ? 0.6 : 1 }}
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
        </button>
      </div>

      {loading && logged === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', padding: '1rem 0' }}>
          <Loader2 size={16} className="animate-spin" color={C.brass} />
          <span style={{ fontSize: '0.78rem', color: C.walnutSoft }}>Loading…</span>
        </div>
      ) : error ? (
        <EmptyNote text={`Could not read the energy log — ${error}`} />
      ) : logged === 0 ? (
        <EmptyNote text="Nothing logged yet. Set today's charge and the line starts here." />
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            height="auto"
            role="img"
            aria-label={`Energy level over the last ${DAYS} days`}
            style={{ display: 'block', overflow: 'visible' }}
          >
            <title>{`Energy level, last ${DAYS} days`}</title>

            {/* Three faint rungs so the line can be read as high / medium / low at a glance. */}
            {[3, 2, 1].map((v) => (
              <line
                key={v}
                x1={PAD_X}
                x2={W - PAD_X}
                y1={yAt(v)}
                y2={yAt(v)}
                stroke={C.line}
                strokeWidth="1"
                strokeDasharray="3 4"
                opacity="0.55"
              />
            ))}

            {/* Today's column — read right-to-left and the line's end is now. */}
            <line
              x1={xAt(DAYS - 1)}
              x2={xAt(DAYS - 1)}
              y1={PAD_Y - 3}
              y2={BASELINE}
              stroke={C.brass}
              strokeWidth="1"
              strokeDasharray="2 3"
              opacity="0.4"
            />

            {areaPath && <path d={areaPath} fill={C.brassLight} opacity="0.35" />}
            {points.length > 1 && (
              <path d={linePath} fill="none" stroke={C.brass} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
            )}

            {points.map((p) => {
              const isLast = lastPoint && p.key === lastPoint.key;
              return (
                <circle
                  key={p.key}
                  cx={xAt(p.i)}
                  cy={yAt(p.v)}
                  r={isLast ? 3.2 : 2.1}
                  fill={LEVEL_COLOR[p.level] || C.walnutSoft}
                  stroke={C.paper}
                  strokeWidth={isLast ? 1 : 0}
                />
              );
            })}
          </svg>

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.45rem', flexWrap: 'wrap' }}>
            {['high', 'med', 'low'].map((k) => (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.66rem', color: C.walnutSoft }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: LEVEL_COLOR[k] }} />
                {LEVEL_LABEL[k]}
              </span>
            ))}
            {logged < DAYS && (
              <span style={{ fontSize: '0.66rem', color: C.walnutSoft, marginLeft: 'auto' }}>
                gaps are days with nothing logged
              </span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
