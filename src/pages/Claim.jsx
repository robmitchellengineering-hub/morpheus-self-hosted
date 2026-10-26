import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { KeyRound, Loader2, Check, AlertTriangle, LogIn } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Claim — the page the checkout success URL lands on (U-11).
//
// The session id in the URL is a bearer token: unguessable and single-use. This page does NOT decide anything —
// `claimLicence` takes the session, confirms with Stripe that it was paid, and either returns the licence bound
// to the signed-in account or refuses with a reason. So there is no rule here to drift from the server's.
//
// Signed out is the expected first state, not an error: a buyer who has never used Morpheus lands here straight
// from Stripe. The page says so and offers the way in, preserving the session id across the round trip.

// Shown on the page and published beside the tarball, so a buyer can compare rather than trust.
const PKG_SHA256 = '644807837d60914f914fed41d8a6d212cce3317bfd35e5456aaaf5ef965a08d8';

export default function Claim() {
  const [params] = useSearchParams();
  const sessionId = params.get('session_id') || params.get('sessionId') || '';
  const [state, setState] = useState({ status: 'idle' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setState({ status: 'error', message: 'This link is missing its checkout reference. Open the link from your receipt, or contact us.' });
      return;
    }
    let cancelled = false;
    (async () => {
      setState({ status: 'asking' });
      try {
        const { data } = await base44.functions.invoke('claimLicence', { sessionId });
        if (cancelled) return;
        setState({ status: 'ok', licence: data?.licence, plan: data?.plan, seats: data?.seats, already: data?.state === 'already-claimed' });
      } catch (e) {
        if (cancelled) return;
        const status = e?.response?.status || e?.status || e?.statusCode;
        const text = String(e?.message || '');
        // Three ways to be signed out: a status, a message, or the function's own 401 wording. The buyer
        // arriving with no account is the EXPECTED first visitor here, so guessing wrong strands them.
        if (status === 401 || /sign in/i.test(text)) setState({ status: 'signed-out' });
        else setState({ status: 'error', message: text || 'That licence could not be issued.' });
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.licence);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* the licence is on screen anyway */ }
  };

  const loginHref = `/login?returnTo=${encodeURIComponent(`/claim?session_id=${sessionId}`)}`;

  return (
    <div className="min-h-dvh bg-[#05070d] text-slate-200 px-4 py-12">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
          <KeyRound className="w-5 h-5 text-indigo-400" /> Your licence
        </h1>

        {(state.status === 'idle' || state.status === 'asking') && (
          <p className="mt-6 flex items-center gap-3 text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Confirming your purchase…
          </p>
        )}

        {state.status === 'signed-out' && (
          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/40 px-6 py-8">
            <p className="text-slate-300 font-medium">Sign in to receive it</p>
            <p className="mt-2 text-sm text-slate-500">
              A licence belongs to an account, so the tool can check it and you can revoke it later. One step:
              sign in and this page picks up where it left off.
            </p>
            <Link to={loginHref} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
              <LogIn className="w-4 h-4" /> Sign in or create an account
            </Link>
            <p className="mt-3 text-xs text-slate-600">Your checkout reference is kept in the link — nothing is lost.</p>
          </div>
        )}

        {state.status === 'error' && (
          <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-6 py-5 text-sm text-amber-200">
            <AlertTriangle className="w-4 h-4 inline mb-0.5" /> {state.message}
            <p className="mt-3 text-amber-200/80">
              Nothing was issued. If you were charged, send the receipt to{' '}
              <a className="underline" href="mailto:info@valiantmusic.com.au">info@valiantmusic.com.au</a> and we
              will sort it.
            </p>
          </div>
        )}

        {state.status === 'ok' && (
          <div className="mt-6">
            <p className="text-sm text-slate-400">
              {state.already ? 'You had already claimed this purchase.' : 'Issued to your account.'} {state.plan} plan ·{' '}
              {state.seats} seat{state.seats === 1 ? '' : 's'} · expires in 365 days.
            </p>
            <pre className="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-black/60 p-4 text-[11px] leading-relaxed text-emerald-300">{state.licence}</pre>
            <div className="mt-3 flex flex-wrap gap-3">
              <button onClick={copy} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : null} {copied ? 'Copied' : 'Copy licence'}
              </button>
              <Link to="/licences" className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-slate-200">Manage licences →</Link>
            </div>
            <div className="mt-6 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Install it</p>
              {/* The package is not on npm, so `npm install -g valiant-verification-sdk` would fail. The link and
                  the checksum are the instructions: download, verify, install, then the licence from above. */}
              <a
                href="/downloads/valiant-verification-sdk-0.2.0.tgz"
                className="text-sm text-indigo-300 underline hover:text-indigo-200"
                download
              >
                valiant-verification-sdk-0.2.0.tgz
              </a>
              <span className="ml-2 text-[11px] text-slate-500">sha256 {PKG_SHA256.slice(0, 16)}…</span>
              <pre className="mt-2 overflow-x-auto text-[11px] text-slate-300">
                {'shasum -a 256 -c valiant-verification-sdk-0.2.0.tgz.sha256\n' +
                 'npm install -g ./valiant-verification-sdk-0.2.0.tgz\n' +
                 'valiant licence <the string above>\n' +
                 'cd your-repo && valiant verify --corpus'}
              </pre>
              <p className="mt-2 text-[11px] text-slate-500">
                <code>--corpus</code> runs the four shipped reference guards straight away, so the first run does
                something even before you write any gates of your own.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
