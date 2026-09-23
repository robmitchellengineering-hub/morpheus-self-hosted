import { useState } from 'react';
import { Heart, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// New — not a base44 port. Mirrors base44's live "KEEP MORPHEUS ALIVE" donate
// widget on the landing page, which prior audits missed entirely because they
// only ever covered the logged-in /workspace app. Collapsed by default, same
// as base44's version. Backed by server/src/functions/createDonationCheckout.js
// (reuses the marketplace's existing Stripe account).
const TIERS = [
  { id: 'neo', amount: 1, label: '$1 · NEO', body: 'Free your mind. Start small.' },
  { id: 'trinity', amount: 3, label: '$3 · TRINITY', body: 'Ride the wave. Hack the Matrix.' },
  { id: 'oracle', amount: 5, label: '$5 · THE ORACLE', body: 'Know thyself. Fund the prophecy.' },
  { id: 'keymaker', amount: null, label: 'CUSTOM · THE KEYMAKER', body: 'Forge your own path.' },
];

export default function DonateWidget() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('neo');
  const [customAmount, setCustomAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const activeAmount = selected === 'keymaker' ? Number(customAmount) : TIERS.find((t) => t.id === selected)?.amount;
  const canDonate = Number.isFinite(activeAmount) && activeAmount >= 1;

  const donate = async () => {
    if (!canDonate) {
      setError('Enter an amount of at least $1.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const origin = window.location.origin;
      const res = await base44.functions.invoke('createDonationCheckout', {
        amount: activeAmount,
        // amount is carried through to the return URL purely so
        // DonationThankYouModal.jsx can personalize its thank-you copy —
        // it's the client-side value already known here, not re-verified
        // against Stripe (same trust level as the ?credits=success flow).
        successUrl: `${origin}/?donated=success&amount=${activeAmount}`,
        cancelUrl: `${origin}/?donated=cancelled`,
      });
      if (res.data?.url) {
        window.location.href = res.data.url;
      }
    } catch (e) {
      setError(e.message || 'Could not start checkout');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-6 mx-auto max-w-lg text-left border border-primary/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-primary/80 hover:text-primary transition-colors"
      >
        <span className="flex items-center gap-2 text-xs font-display tracking-[0.15em]">
          <Heart size={14} /> // KEEP MORPHEUS ALIVE
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-primary/20 pt-3">
          <p className="text-xs text-ink/60 mb-3 leading-relaxed">
            Donations keep Morpheus alive — and free for everyone who follows the white rabbit. Every credit fuels the Construct.
          </p>

          <div className="space-y-2">
            {TIERS.map((tier) => (
              <button
                key={tier.id}
                onClick={() => setSelected(tier.id)}
                className={`w-full flex items-center justify-between gap-3 border px-3 py-2.5 text-left transition-colors ${
                  selected === tier.id ? 'border-primary bg-primary/5' : 'border-primary/20 hover:border-primary/50'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-xs text-primary font-bold">{tier.label}</div>
                  <div className="text-[10px] text-ink/55 mt-0.5">{tier.body}</div>
                </div>
                {selected === tier.id && <span className="text-primary shrink-0">✓</span>}
              </button>
            ))}
            {selected === 'keymaker' && (
              <div className="flex items-center gap-2 border border-primary/30 px-3 py-2">
                <span className="text-primary/60 text-sm">$</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={customAmount}
                  onChange={(e) => setCustomAmount(e.target.value)}
                  placeholder="Amount"
                  className="bg-transparent text-ink text-sm outline-none w-full"
                  autoFocus
                />
              </div>
            )}
          </div>

          {error && <p className="text-red-400 text-xs mt-3">// {error}</p>}

          <button
            onClick={donate}
            disabled={loading || !canDonate}
            className="w-full mt-4 flex items-center justify-center gap-2 text-sm text-black bg-primary hover:bg-[#39ff14] px-4 py-2.5 disabled:opacity-40 font-bold tracking-wider"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Heart size={14} />} DONATE NOW
          </button>
          <p className="text-[10px] text-ink/45 mt-2 text-center">
            // Secure checkout via Stripe. Your contribution keeps the Construct running.
          </p>
        </div>
      )}
    </div>
  );
}
