// AdminLicences — the operator's register: every licence, every account, with revoke.
//
// WHY IT IS A TAB AND NOT A ROUTE. It belongs where an operator already is (the Admin panel), and a page reachable only
// by typing a URL is a dead end. It decides nothing: the server computes each row's state and returns only the fields an
// operator needs (licenceRegister.js owns that allow-list), so this file cannot drift from the server's rules.
//
// NO DEAD ENDS (the standing UI rule): a failed load offers a retry, an empty filter result says which filter is empty,
// a revoke asks first, and a revoke that has already happened says so instead of failing.
import { useState, useEffect, useCallback } from 'react';
import { KeyRound, Loader2, RefreshCw, Search, ShieldCheck, ShieldOff, Clock, AlertTriangle } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const STATE_STYLE = {
  active: { badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', Icon: ShieldCheck, label: 'Active' },
  expired: { badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30', Icon: Clock, label: 'Expired' },
  revoked: { badge: 'bg-red-500/15 text-red-300 border-red-500/30', Icon: ShieldOff, label: 'Revoked' },
};

const fmt = (v) => {
  if (!v) return '—';
  try { return new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return String(v); }
};

export default function AdminLicences() {
  const [rows, setRows] = useState(null);
  const [estate, setEstate] = useState(null);
  const [page, setPage] = useState(null);
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async ({ append = false, offset = 0 } = {}) => {
    setError(null);
    const { data } = await base44.functions.invoke('adminListLicences', { q, state: state || undefined, limit: 50, offset });
    setRows((prev) => (append && prev ? [...prev, ...data.licences] : data.licences));
    setEstate(data.estate);
    setPage(data.page);
  }, [q, state]);

  useEffect(() => {
    load().catch((e) => setError(e?.message || 'Could not load the licence register.'));
  }, [load]);

  const revoke = async (jti) => {
    if (!window.confirm(`Revoke ${jti}?\n\nThe customer's next check fails, and this cannot be undone.`)) return;
    setBusy(jti); setError(null); setNotice(null);
    try {
      const { data } = await base44.functions.invoke('adminRevokeLicence', { jti });
      setNotice(data.alreadyRevoked ? `${jti} was already revoked.` : `${jti} revoked.`);
      await load();
    } catch (e) {
      setError(e?.message || 'Revoke failed.');
    } finally {
      setBusy(null);
    }
  };

  const more = page && rows && rows.length < page.total;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound size={18} className="text-primary" />
        <h2 className="text-sm tracking-widest text-heading">LICENCE REGISTER</h2>
      </div>

      <p className="text-xs text-ink-strong">
        Every licence on every account. Revoking here is immediate for the customer&apos;s next check and is written to the
        audit log. A licence issued to you is also on your own <span className="text-ink-strong">/licences</span> page.
      </p>

      {estate && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          {[['All', estate.all], ['Active', estate.active], ['Expired', estate.expired], ['Revoked', estate.revoked]].map(([label, n]) => (
            <div key={label} className="border border-primary/20 rounded px-3 py-2">
              <div className="text-primary/60 tracking-wider">{label}</div>
              <div className="text-heading text-lg">{n}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 border border-primary/20 rounded px-2 py-1">
          <Search size={13} className="text-primary/60" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="jti or account email"
            className="bg-transparent text-xs text-ink-strong outline-none w-56"
          />
        </div>
        <select
          value={state}
          onChange={(e) => setState(e.target.value)}
          className="bg-transparent border border-primary/20 rounded px-2 py-1 text-xs text-ink-strong"
        >
          <option value="">any state</option>
          <option value="active">active</option>
          <option value="expired">expired</option>
          <option value="revoked">revoked</option>
        </select>
        <button
          onClick={() => load().catch((e) => setError(e?.message || 'Could not reload.'))}
          className="flex items-center gap-1 text-xs text-primary/80 hover:text-primary px-2 py-1"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {notice && <div className="text-xs text-emerald-300 border border-emerald-500/30 bg-emerald-500/10 rounded px-3 py-2">{notice}</div>}
      {error && (
        <div className="text-xs text-red-300 border border-red-500/30 bg-red-500/10 rounded px-3 py-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1"><AlertTriangle size={13} /> {error}</span>
          <button onClick={() => load().catch(() => {})} className="underline">Try again</button>
        </div>
      )}

      {rows === null ? (
        <div className="flex items-center gap-2 text-xs text-ink-strong"><Loader2 size={14} className="animate-spin" /> Loading the register…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-ink-strong border border-primary/20 rounded px-3 py-4">
          No licence matches {q ? `“${q}”` : 'this filter'}{state ? ` in state ${state}` : ''}.{' '}
          <button onClick={() => { setQ(''); setState(''); }} className="text-primary underline">Clear the filter</button>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-primary/60 tracking-wider text-left border-b border-primary/20">
                <th className="py-2 pr-3">ACCOUNT</th>
                <th className="py-2 pr-3">JTI</th>
                <th className="py-2 pr-3">PLAN</th>
                <th className="py-2 pr-3">SEATS</th>
                <th className="py-2 pr-3">ISSUED</th>
                <th className="py-2 pr-3">EXPIRES</th>
                <th className="py-2 pr-3">STATE</th>
                <th className="py-2">ACTION</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = STATE_STYLE[r.state] ?? STATE_STYLE.expired;
                return (
                  <tr key={r.jti} className="border-b border-primary/10">
                    <td className="py-2 pr-3 text-ink-strong">{r.owner?.email ?? '—'}</td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-ink-strong">{r.jti}</td>
                    <td className="py-2 pr-3 text-ink-strong">{r.plan}</td>
                    <td className="py-2 pr-3 text-ink-strong">{r.seats}</td>
                    <td className="py-2 pr-3 text-ink-strong">{fmt(r.issuedAt)}</td>
                    <td className="py-2 pr-3 text-ink-strong">{fmt(r.expiresAt)}</td>
                    <td className="py-2 pr-3">
                      <span className={`inline-flex items-center gap-1 border rounded px-1.5 py-0.5 ${s.badge}`}>
                        <s.Icon size={11} /> {s.label}
                      </span>
                    </td>
                    <td className="py-2">
                      {r.state === 'revoked' ? (
                        <span className="text-ink-strong">revoked {fmt(r.revokedAt)}</span>
                      ) : (
                        <button
                          onClick={() => revoke(r.jti)}
                          disabled={busy === r.jti}
                          className="text-red-400/80 hover:text-red-300 disabled:opacity-50 flex items-center gap-1"
                        >
                          {busy === r.jti ? <Loader2 size={11} className="animate-spin" /> : <ShieldOff size={11} />} Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {more && (
        <button
          onClick={() => load({ append: true, offset: rows.length }).catch((e) => setError(e?.message || 'Could not load more.'))}
          className="text-xs text-primary underline"
        >
          Load more ({rows.length} of {page.total})
        </button>
      )}
    </div>
  );
}
