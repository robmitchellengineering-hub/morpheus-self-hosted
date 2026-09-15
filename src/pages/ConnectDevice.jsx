import { useEffect, useState, useCallback } from 'react';
import { Link2, Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import MatrixRain from '@/components/matrix/MatrixRain';

// Morpheus Connect's approval screen — where a person approves a native/
// compiled app's request to act as them (see server/src/lib/deviceToken.js
// for the full design). Not wrapped in the generic <ProtectedRoute> group
// (see App.jsx's comment) since that redirects to a bare /login with no way
// back to this exact URL — the ?code= has to survive the login round trip,
// so this page drives that redirect itself via redirectToLogin.
export default function ConnectDevice() {
  const { isAuthenticated, isLoadingAuth, authChecked, checkUserAuth } = useAuth();
  const [codeInput, setCodeInput] = useState('');
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get('code') || '');
  const [pending, setPending] = useState(null); // { client_label, status }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [outcome, setOutcome] = useState(null); // 'approved' | 'denied'

  useEffect(() => {
    if (!authChecked && !isLoadingAuth) checkUserAuth();
  }, [authChecked, isLoadingAuth, checkUserAuth]);

  useEffect(() => {
    if (authChecked && !isLoadingAuth && !isAuthenticated) {
      base44.auth.redirectToLogin(window.location.pathname + window.location.search);
    }
  }, [authChecked, isLoadingAuth, isAuthenticated]);

  const loadPending = useCallback(async (c) => {
    if (!c) return;
    setLoading(true);
    setError(null);
    try {
      const data = await base44.auth.getDevicePending(c);
      setPending(data);
    } catch (e) {
      setError(e.message || 'Could not find that connection request.');
      setPending(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated && code) loadPending(code);
  }, [isAuthenticated, code, loadPending]);

  const submitCode = (e) => {
    e.preventDefault();
    const trimmed = codeInput.trim().toUpperCase();
    if (trimmed) setCode(trimmed);
  };

  const approve = async () => {
    setLoading(true);
    setError(null);
    try {
      await base44.auth.approveDevice(code);
      setOutcome('approved');
    } catch (e) {
      setError(e.message || 'Could not approve this connection.');
    } finally {
      setLoading(false);
    }
  };

  const deny = async () => {
    setLoading(true);
    setError(null);
    try {
      await base44.auth.denyDevice(code);
      setOutcome('denied');
    } catch (e) {
      setError(e.message || 'Could not decline this connection.');
    } finally {
      setLoading(false);
    }
  };

  if (isLoadingAuth || !authChecked || !isAuthenticated) {
    return (
      <div className="relative min-h-screen bg-background text-primary font-mono flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-primary/60" />
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-background text-primary font-mono">
      <MatrixRain opacity={0.05} />
      <div className="relative z-10 max-w-md mx-auto px-6 py-16 safe-top">
        <div className="flex items-center gap-2 mb-6">
          <Link2 size={22} className="text-primary neon-glow" />
          <h1 className="text-xl font-display tracking-widest neon-glow text-heading">MORPHEUS CONNECT</h1>
        </div>

        {outcome === 'approved' ? (
          <div className="border border-success/30 bg-success/5 px-4 py-4 flex items-start gap-3">
            <CheckCircle2 size={18} className="text-success shrink-0 mt-0.5" />
            <div>
              <p className="text-ink text-sm mb-1">Connected.</p>
              <p className="text-primary/60 text-xs">You can close this tab and return to the app.</p>
            </div>
          </div>
        ) : outcome === 'denied' ? (
          <div className="border border-primary/20 bg-primary/5 px-4 py-4">
            <p className="text-ink text-sm">Declined. The app was not connected to your account.</p>
          </div>
        ) : !code ? (
          <form onSubmit={submitCode} className="border border-primary/20 bg-primary/5 px-4 py-4">
            <p className="text-primary/60 text-xs mb-3">Enter the code shown in the app.</p>
            <div className="flex gap-2">
              <input
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="XXXX-XXXX"
                className="flex-1 bg-background border border-primary/30 px-3 py-1.5 text-sm text-ink placeholder:text-primary/30 tracking-widest uppercase"
              />
              <button type="submit" className="px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-xs transition-colors">
                CONTINUE
              </button>
            </div>
          </form>
        ) : loading && !pending ? (
          <div className="flex items-center gap-2 text-primary/60 text-sm py-8 justify-center">
            <Loader2 size={16} className="animate-spin" /> Loading...
          </div>
        ) : error ? (
          <div className="border border-danger/30 bg-danger/5 px-4 py-4 flex items-start gap-3">
            <XCircle size={18} className="text-danger shrink-0 mt-0.5" />
            <p className="text-ink text-sm">{error}</p>
          </div>
        ) : pending?.status && pending.status !== 'pending' ? (
          <div className="border border-warning/30 bg-warning/5 px-4 py-4 flex items-start gap-3">
            <AlertTriangle size={18} className="text-warning shrink-0 mt-0.5" />
            <p className="text-ink text-sm">
              This connection request is already {pending.status}. Ask the app to generate a new code.
            </p>
          </div>
        ) : pending ? (
          <div className="border border-primary/20 bg-primary/5 px-4 py-4">
            <p className="text-ink text-sm mb-4">
              <strong className="text-primary">{pending.client_label}</strong> wants to connect to your Morpheus
              account and use your credits for AI actions.
            </p>
            <div className="flex gap-2">
              <button
                onClick={approve}
                disabled={loading}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-success text-success hover:bg-success hover:text-black text-xs font-bold transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} APPROVE
              </button>
              <button
                onClick={deny}
                disabled={loading}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-primary/30 text-primary/70 hover:text-primary text-xs transition-colors disabled:opacity-50"
              >
                <XCircle size={12} /> DENY
              </button>
            </div>
          </div>
        ) : null}

        <p className="text-primary/40 text-[11px] mt-6">
          Only approve this if you just started this connection from an app on your own device.
        </p>
      </div>
    </div>
  );
}
