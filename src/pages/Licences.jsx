import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Loader2, ShieldCheck, ShieldOff, Clock, ArrowLeft, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Licences — the private page where an account sees and revokes the credentials it holds for the
// Valiant Verification SDK.
//
// The server decides everything that matters and this page decides nothing: `listLicences` returns only
// the caller's own rows and computes each row's `state` (active / expired / revoked) from revoked_at and
// expires_at. So there is no client-side rule here to drift from the server's — the page renders what it
// is told, and the revoke button sends a jti that the server scopes to this account in its WHERE clause.
//
// NO DEAD ENDS (the standing UI rule): every state has a next step — no licences points at how to get
// one, an expired one says how to renew, a revoked one says who revoked it, and a failed load offers a
// retry rather than an error with nothing to press.

const STATE_STYLE = {
  active: { badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', Icon: ShieldCheck, label: 'Active' },
  expired: { badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30', Icon: Clock, label: 'Expired' },
  revoked: { badge: 'bg-red-500/15 text-red-300 border-red-500/30', Icon: ShieldOff, label: 'Revoked' },
};

function fmtDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return String(value);
  }
}

export default function Licences() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data } = await base44.functions.invoke('listLicences', {});
      setRows(Array.isArray(data?.licences) ? data.licences : []);
    } catch (e) {
      setError(e?.message || 'Could not load your licences.');
      setRows([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = async (jti) => {
    if (!window.confirm('Revoke this licence? Any build using it stops verifying at its next check.')) return;
    setBusy(jti);
    try {
      await base44.functions.invoke('revokeLicence', { jti });
      await load();
    } catch (e) {
      setError(e?.message || 'Could not revoke that licence.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-dvh bg-[#05070d] text-slate-200 px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <Link to="/workspace" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200 mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to workspace
        </Link>

        <div className="flex items-start justify-between gap-4 mb-2">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
              <KeyRound className="w-5 h-5 text-indigo-400" /> Licences
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Credentials your account holds for the Valiant Verification SDK. Each one is signed by this
              deployment and verified offline by the tool — nothing is checked with a server at build time.
            </p>
          </div>
          <button
            onClick={load}
            disabled={rows === null}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        {error && (
          <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}{' '}
            <button onClick={load} className="underline hover:text-white">Try again</button>
          </div>
        )}

        {rows === null && (
          <div className="mt-10 flex items-center gap-3 text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading your licences…
          </div>
        )}

        {rows !== null && rows.length === 0 && !error && (
          <div className="mt-8 rounded-xl border border-slate-800 bg-slate-900/40 px-6 py-10 text-center">
            <KeyRound className="w-8 h-8 text-slate-600 mx-auto" />
            <p className="mt-3 text-slate-300 font-medium">No licences yet</p>
            <p className="mt-1 text-sm text-slate-500">
              A licence is issued to this account when you start a plan.
            </p>
            <Link
              to="/market"
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              See the plans
            </Link>
          </div>
        )}

        {rows !== null && rows.length > 0 && (
          <ul className="mt-8 space-y-3">
            {rows.map((r) => {
              const s = STATE_STYLE[r.state] || STATE_STYLE.active;
              const { Icon } = s;
              return (
                <li key={r.jti} className="rounded-xl border border-slate-800 bg-slate-900/40 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <Icon className="w-4 h-4 text-slate-400" />
                      <div>
                        <div className="font-medium text-white capitalize">{r.plan} plan</div>
                        <div className="text-xs text-slate-500">
                          {r.seats} seat{r.seats === 1 ? '' : 's'} · expires {fmtDate(r.expires_at)}
                          {r.revoked_at ? ` · revoked ${fmtDate(r.revoked_at)}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`rounded-full border px-2.5 py-0.5 text-xs ${s.badge}`}>{s.label}</span>
                      {r.state === 'active' && (
                        <button
                          onClick={() => revoke(r.jti)}
                          disabled={busy === r.jti}
                          className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          {busy === r.jti ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </div>
                  </div>
                  {r.state === 'expired' && (
                    <p className="mt-2 text-xs text-amber-300/80">
                      Expired licences stop verifying. <Link to="/market" className="underline">Renew it</Link> to
                      get a new one.
                    </p>
                  )}
                  {r.state === 'revoked' && (
                    <p className="mt-2 text-xs text-red-300/80">
                      This one will not verify. It stays listed so the record is complete.
                    </p>
                  )}
                  <p className="mt-2 font-mono text-[11px] text-slate-600">{r.jti}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
