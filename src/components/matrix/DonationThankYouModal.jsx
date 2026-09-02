import { useState, useEffect } from 'react';
import { Heart, X } from 'lucide-react';

// New — not a base44 port. DonateWidget.jsx's successUrl sends a returning
// donor back to `/?donated=success&amount=<n>` (see its `donate()`); until
// now nothing on Landing.jsx ever looked at that param, so a completed
// donation landed back on the page with zero acknowledgement. Rob's ask:
// "a big thank you message with a bit about what your helping support" —
// so this is a full modal (matching InsufficientCreditsModal.jsx's pattern
// for a Stripe-return query param: read it once on mount, act on it, strip
// it from the URL via replaceState) rather than a toast, since a donation
// is a bigger moment than a routine credit purchase.
//
// Trusts the query param the way InsufficientCreditsModal.jsx trusts
// `?credits=success` — no server round-trip to verify the session, since
// this is purely a thank-you courtesy, not something gating access to
// anything. `amount` is whatever DonateWidget.jsx's client-side state held
// right before redirecting to Stripe; if it's missing or malformed (e.g.
// someone lands on this URL by hand) the copy just skips the dollar figure
// rather than showing something wrong.
export default function DonationThankYouModal() {
  const [amount, setAmount] = useState(null); // number | null
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const donated = params.get('donated');
    if (donated !== 'success' && donated !== 'cancelled') return;

    if (donated === 'success') {
      const parsed = Number(params.get('amount'));
      setAmount(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
      setVisible(true);
    }
    // A cancelled donation gets no modal — just a quiet URL cleanup below,
    // same treatment InsufficientCreditsModal.jsx gives `credits=cancelled`.

    params.delete('donated');
    params.delete('amount');
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : '');
    window.history.replaceState({}, '', cleanUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4">
      <div className="bg-background border border-primary/40 max-w-md w-full p-6 font-mono text-center relative">
        <button
          onClick={() => setVisible(false)}
          className="absolute top-3 right-3 text-primary/50 hover:text-primary"
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>

        <Heart className="mx-auto text-primary neon-glow mb-3" size={32} />

        <h2 className="font-display text-2xl md:text-3xl text-heading tracking-[0.2em] neon-glow mb-3">
          THANK YOU
        </h2>

        <p className="text-primary/70 text-sm leading-relaxed mb-4">
          {amount != null ? (
            <>Your <span className="text-primary font-bold">${amount.toLocaleString()}</span> just went straight into keeping Morpheus alive.</>
          ) : (
            <>Your donation just went straight into keeping Morpheus alive.</>
          )}
        </p>

        <p className="text-primary/60 text-xs leading-relaxed mb-4">
          // It covers the AI compute behind the 200 free credits every new account starts with, keeps the servers and infrastructure running, and funds what gets built next. Because of contributions like yours, Morpheus stays free to enter for anyone who wants to build real, deployable software — no lock-in, no paywall at the door.
        </p>

        <button
          onClick={() => setVisible(false)}
          className="w-full mt-1 flex items-center justify-center gap-2 text-sm text-black bg-primary hover:bg-[#39ff14] px-4 py-2.5 font-bold tracking-wider"
        >
          BACK TO THE CONSTRUCT
        </button>
      </div>
    </div>
  );
}
