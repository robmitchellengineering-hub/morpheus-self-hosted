import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { DollarSign, Loader2, ArrowLeft, Plus, Trash2, Save, Pencil, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import MatrixRain from '@/components/matrix/MatrixRain';

// Admin-only running cost tracker — a real Morpheus feature version of the
// one-off cost-tracker artifact Rob first got as a standalone page. Gated
// to admins only (Rob is currently the sole admin) via the same
// ProtectedRoute adminOnly wrapper as RebuildBlueprint/UpdatesPlan/etc., and
// only linked from the landing page when isAdmin.
//
// Backed by the generic entity CRUD engine (server/src/entities.js) against
// the new CostSnapshot model — one row, upserted on save, same
// single-row-per-admin pattern as RebuildDoc/UpdatesPlan. There is no live
// billing-API integration anywhere in this stack (Netlify/Northflank/
// Supabase/Stripe billing dashboards aren't polled) — figures are checked
// by hand and entered here, same as the artifact version was, but now
// editable in place instead of needing a new artifact published every time
// something changes.

const CATEGORY_OPTIONS = ['Hosting', 'Domain', 'Database', 'AI / LLM', 'Payments', 'Other'];
const TIER_OPTIONS = ['paid', 'free'];

// Seeded with the figures gathered and verified against provider dashboards
// as of 27 Aug 2026 (see the operational plan doc) — shown until the admin
// saves a real snapshot, at which point the saved row takes over.
const DEFAULT_ITEMS = [
  { service: 'Netlify (frontend hosting)', category: 'Hosting', monthly: 9, annual: 0, tier: 'paid', flag: '', note: 'Personal plan, upgraded to fix a build-credit outage' },
  { service: 'morpheus.nz domain', category: 'Domain', monthly: 0, annual: 15.6, tier: 'paid', flag: '', note: 'Registrar/DNS: Cloudflare' },
  { service: 'Separate web hosting on morpheus.nz', category: 'Domain', monthly: 0, annual: 16, tier: 'paid', flag: 'watch', note: 'Provider not yet confirmed — verify and link' },
  { service: 'Northflank (backend hosting)', category: 'Hosting', monthly: 0, annual: 0, tier: 'free', flag: '', note: 'Free tier — watch for overage as usage grows' },
  { service: 'Supabase (database)', category: 'Database', monthly: 0, annual: 0, tier: 'free', flag: '', note: 'Free tier' },
  { service: 'Gemini API (LLM)', category: 'AI / LLM', monthly: 0, annual: 0, tier: 'free', flag: 'watch', note: 'No Cloud Billing account linked — free tier causes 503 congestion' },
  { service: 'GitHub', category: 'Other', monthly: 0, annual: 0, tier: 'free', flag: '', note: 'Free tier' },
  { service: 'Cloudflare', category: 'Other', monthly: 0, annual: 0, tier: 'free', flag: '', note: 'Free plan (DNS/registrar)' },
  { service: 'Stripe', category: 'Payments', monthly: 0, annual: 0, tier: 'free', flag: '', note: 'No fixed fee — 2.65%+NZ$0.30 domestic / 3.65%+NZ$0.30 intl per transaction' },
];

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

function computeTotals(items) {
  const monthlyFixed = items.reduce((s, i) => s + num(i.monthly), 0);
  const annualExtra = items.reduce((s, i) => s + num(i.annual), 0);
  const monthlyEquivalent = monthlyFixed + annualExtra / 12;
  return { monthlyFixed, annualExtra, monthlyEquivalent };
}

export default function CostTracker() {
  const [items, setItems] = useState(DEFAULT_ITEMS);
  const [summary, setSummary] = useState('');
  const [snapshotId, setSnapshotId] = useState(null);
  const [updatedDate, setUpdatedDate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await base44.entities.CostSnapshot.list('-created_date', 1);
      if (list.length > 0) {
        const snap = list[0];
        setSnapshotId(snap.id);
        setUpdatedDate(snap.updated_date || snap.created_date);
        try {
          const parsed = JSON.parse(snap.items || '[]');
          setItems(Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_ITEMS);
        } catch {
          setItems(DEFAULT_ITEMS);
        }
        setSummary(snap.summary || '');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateItem = (idx, field, value) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));
  };

  const addItem = () => {
    setItems((prev) => [...prev, { service: '', category: 'Other', monthly: 0, annual: 0, tier: 'paid', flag: '', note: '' }]);
  };

  const removeItem = (idx) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const cancelEdit = () => {
    setEditing(false);
    load();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = { items: JSON.stringify(items), summary };
      if (snapshotId) {
        await base44.entities.CostSnapshot.update(snapshotId, payload);
      } else {
        const created = await base44.entities.CostSnapshot.create(payload);
        setSnapshotId(created.id);
      }
      setUpdatedDate(new Date().toISOString());
      setEditing(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const { monthlyFixed, annualExtra, monthlyEquivalent } = computeTotals(items);

  return (
    <div className="relative min-h-screen bg-background text-primary font-mono">
      <MatrixRain opacity={0.04} />
      <div className="relative z-10 max-w-4xl mx-auto px-6 py-12 safe-top">
        <Link to="/" className="inline-flex items-center gap-1.5 text-primary/60 hover:text-primary text-sm mb-6 transition-colors">
          <ArrowLeft size={14} /> BACK
        </Link>

        <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
          <div className="flex items-center gap-3">
            <DollarSign size={24} className="text-primary neon-glow" />
            <h1 className="text-2xl md:text-3xl font-display tracking-widest neon-glow text-heading">COST TRACKER</h1>
          </div>
          {!loading && (
            editing ? (
              <div className="flex gap-2">
                <button onClick={cancelEdit} className="flex items-center gap-1.5 px-3 py-1.5 border border-primary/30 text-primary/70 hover:text-primary text-xs transition-colors">
                  <X size={12} /> CANCEL
                </button>
                <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-3 py-1.5 border border-primary text-primary hover:bg-primary hover:text-black transition-colors text-xs font-bold disabled:opacity-50">
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} SAVE
                </button>
              </div>
            ) : (
              <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-xs transition-colors">
                <Pencil size={12} /> EDIT
              </button>
            )
          )}
        </div>
        <p className="text-ink/60 text-sm mb-8">
          // Everything it costs to host and run Morpheus, checked by hand against each provider's billing dashboard. Admin-only — not published anywhere public.
        </p>

        {error && <div className="text-danger text-sm border border-danger/30 px-3 py-2 mb-4">{error}</div>}

        {loading ? (
          <div className="flex items-center gap-2 text-primary/60 text-sm py-12 justify-center">
            <Loader2 size={16} className="animate-spin" /> Loading...
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
              <div className="border border-primary/20 bg-primary/5 p-4">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">MONTHLY FIXED</p>
                <p className="text-xl text-primary neon-glow">${monthlyFixed.toFixed(2)}</p>
              </div>
              <div className="border border-primary/20 bg-primary/5 p-4">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">ANNUAL EXTRAS</p>
                <p className="text-xl text-primary neon-glow">${annualExtra.toFixed(2)}</p>
              </div>
              <div className="border border-success/30 bg-success/5 p-4">
                <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">ALL-IN, MONTHLY EQUIVALENT</p>
                <p className="text-xl text-success neon-glow">${monthlyEquivalent.toFixed(2)}</p>
              </div>
            </div>

            <div className="overflow-x-auto border border-primary/20">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-primary/20 text-primary/50 text-left">
                    <th className="px-3 py-2 font-normal">SERVICE</th>
                    <th className="px-3 py-2 font-normal">CATEGORY</th>
                    <th className="px-3 py-2 font-normal">MONTHLY</th>
                    <th className="px-3 py-2 font-normal">ANNUAL</th>
                    <th className="px-3 py-2 font-normal">TIER</th>
                    <th className="px-3 py-2 font-normal">NOTE</th>
                    {editing && <th className="px-3 py-2 font-normal"></th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => (
                    <tr key={idx} className="border-b border-primary/10 last:border-0 align-top">
                      {editing ? (
                        <>
                          <td className="px-3 py-2">
                            <input value={item.service} onChange={(e) => updateItem(idx, 'service', e.target.value)} className="bg-background border border-primary/30 px-2 py-1 w-full text-primary" />
                          </td>
                          <td className="px-3 py-2">
                            <select value={item.category} onChange={(e) => updateItem(idx, 'category', e.target.value)} className="bg-background border border-primary/30 px-2 py-1 w-full text-primary">
                              {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" value={item.monthly} onChange={(e) => updateItem(idx, 'monthly', e.target.value)} className="bg-background border border-primary/30 px-2 py-1 w-20 text-primary" />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" value={item.annual} onChange={(e) => updateItem(idx, 'annual', e.target.value)} className="bg-background border border-primary/30 px-2 py-1 w-20 text-primary" />
                          </td>
                          <td className="px-3 py-2">
                            <select value={item.tier} onChange={(e) => updateItem(idx, 'tier', e.target.value)} className="bg-background border border-primary/30 px-2 py-1 text-primary">
                              {TIER_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <input value={item.note} onChange={(e) => updateItem(idx, 'note', e.target.value)} className="bg-background border border-primary/30 px-2 py-1 w-full text-primary" />
                          </td>
                          <td className="px-3 py-2">
                            <button onClick={() => removeItem(idx)} className="text-danger/70 hover:text-danger transition-colors">
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-primary">{item.service}</td>
                          <td className="px-3 py-2 text-primary/60">{item.category}</td>
                          <td className="px-3 py-2 text-primary/80">{num(item.monthly) > 0 ? `$${num(item.monthly).toFixed(2)}` : '—'}</td>
                          <td className="px-3 py-2 text-primary/80">{num(item.annual) > 0 ? `$${num(item.annual).toFixed(2)}` : '—'}</td>
                          <td className="px-3 py-2">
                            <span className={item.tier === 'free' ? 'text-info' : 'text-success'}>{item.tier === 'free' ? 'FREE TIER' : 'PAID'}</span>
                            {item.flag === 'watch' && <span className="ml-1.5 text-warning">⚠ WATCH</span>}
                          </td>
                          <td className="px-3 py-2 text-primary/50">{item.note}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {editing && (
              <button onClick={addItem} className="mt-3 flex items-center gap-1.5 px-3 py-1.5 border border-primary/30 text-primary/70 hover:text-primary hover:border-primary text-xs transition-colors">
                <Plus size={12} /> ADD LINE ITEM
              </button>
            )}

            <div className="mt-6">
              <p className="text-[10px] text-primary/50 tracking-[0.2em] mb-1">SUMMARY / NOTES</p>
              {editing ? (
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  rows={3}
                  className="w-full bg-background border border-primary/30 px-3 py-2 text-primary/80 text-xs"
                  placeholder="Anything worth flagging — watch-list items, pending confirmations, etc."
                />
              ) : (
                <p className="text-ink/60 text-xs whitespace-pre-wrap">{summary || '(none)'}</p>
              )}
            </div>

            {updatedDate && (
              <p className="mt-6 text-[10px] text-ink/40">Last updated: {new Date(updatedDate).toLocaleString()}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
