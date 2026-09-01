import { useState, useEffect, useCallback, useRef } from 'react';
import { Coins, Loader2, Check, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Token System Build Plan Step 6 (2026-09-01) — credit balance display +
// token-block purchase flow. Built as a standalone component (not inlined
// into Settings.jsx) per the build plan's own note that this is "the same
// UI surface Command Deck's own token meter will need" — so it can be
// mounted wherever a balance/buy surface is needed, not just here.
//
// Block list mirrors server/src/lib/billing.js's TOKEN_BLOCKS exactly, for
// display only — the actual charge (including any first-purchase recoup
// surcharge) is always computed server-side in createTokenCheckout.js. The
// client only ever sends a block *index*, never a price. Revised 2026-09-02
// to round $2/$4/$8 blocks — see billing.js's TOKEN_BLOCKS comment for the
// pricing derivation.
const TOKEN_BLOCKS = [
  { credits: 400, intendedNetUsd: 2.00 },
  { credits: 800, intendedNetUsd: 4.00 },
  { credits: 1600, intendedNetUsd: 8.00 },
];

// Webhook credit lands async after Stripe redirects back — poll the balance
// a few times rather than trusting it's already updated on the first fetch.
const POLL_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2000;

export default function CreditBalance() {
  const [balance, setBalance] = useState(null);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [buyingIndex, setBuyingIndex] = useState(null);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState(null); // { kind: 'success' | 'cancelled' }
  const pollRef = useRef(null);

  const fetchBalance = useCallback(async () => {
    try {
      const user = await base44.auth.me();
      setBalance(Number(user?.credit_balance ?? 0));
    } catch {
      // Not fatal — balance just won't render; the rest of Settings still works.
    } finally {
      setLoadingBalance(false);
    }
  }, []);

  useEffect(() => {
    fetchBalance();

    const params = new URLSearchParams(window.location.search);
    const credits = params.get('credits');
    if (credits === 'success' || credits === 'cancelled') {
      setBanner({ kind: credits });
      // Clean the query param out of the URL without a reload.
      params.delete('credits');
      const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : '');
      window.history.replaceState({}, '', cleanUrl);
    }
    if (credits === 'success') {
      let attempts = 0;
      pollRef.current = setInterval(() => {
        attempts += 1;
        fetchBalance();
        if (attempts >= POLL_ATTEMPTS && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, POLL_INTERVAL_MS);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchBalance]);

  const buy = async (blockIndex) => {
    setError('');
    setBuyingIndex(blockIndex);
    try {
      const origin = window.location.origin;
      const path = window.location.pathname;
      const res = await base44.functions.invoke('createTokenCheckout', {
        blockIndex,
        successUrl: `${origin}${path}?credits=success`,
        cancelUrl: `${origin}${path}?credits=cancelled`,
      });
      if (res.data?.url) {
        window.location.href = res.data.url;
      } else {
        setError('Could not start checkout');
        setBuyingIndex(null);
      }
    } catch (e) {
      setError(e.message || 'Could not start checkout');
      setBuyingIndex(null);
    }
  };

  return (
    <section className="mb-8 border border-primary/30 p-5">
      <h2 className="text-sm font-display tracking-wider mb-1 text-primary flex items-center gap-2">
        <Coins size={14} /> CREDITS
      </h2>
      <p className="text-xs text-primary/50 mb-4">
        // Every AI action costs a small number of credits — new accounts start with 200 free. Buy more any time; no subscription, no expiry.
      </p>

      {banner?.kind === 'success' && (
        <div className="flex items-center gap-2 border border-primary/40 bg-primary/5 px-3 py-2 mb-4 text-xs text-primary">
          <Check size={14} /> Payment received — your balance updates within a few seconds.
        </div>
      )}
      {banner?.kind === 'cancelled' && (
        <div className="flex items-center gap-2 border border-primary/20 px-3 py-2 mb-4 text-xs text-primary/60">
          <X size={14} /> Checkout cancelled — no charge was made.
        </div>
      )}

      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs text-primary/60 uppercase tracking-wider">Balance</span>
        {loadingBalance ? (
          <Loader2 size={14} className="animate-spin text-primary/50" />
        ) : (
          <span className="text-lg font-display text-primary">{balance != null ? balance.toFixed(2) : '—'} credits</span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {TOKEN_BLOCKS.map((block, i) => (
          <button
            key={block.credits}
            onClick={() => buy(i)}
            disabled={buyingIndex !== null}
            className="text-left border border-primary/20 hover:border-primary/50 p-3 transition-colors disabled:opacity-40"
          >
            <div className="text-xs font-display tracking-wider text-primary">{block.credits.toLocaleString()} CREDITS</div>
            <div className="text-[10px] text-primary/55 mt-1">~${block.intendedNetUsd.toFixed(2)} + card fees</div>
            <div className="mt-2 flex items-center gap-1.5 text-xs text-primary">
              {buyingIndex === i ? <Loader2 size={12} className="animate-spin" /> : null}
              {buyingIndex === i ? 'Redirecting…' : 'Buy'}
            </div>
          </button>
        ))}
      </div>

      {error && <p className="text-red-400 text-xs mt-3">// {error}</p>}
      <p className="text-[10px] text-primary/45 mt-3">
        // Secure checkout via Stripe. Card fees are added on top so Morpheus receives the full credit value shown above.
      </p>
    </section>
  );
}
