import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Coins, Loader2, X } from 'lucide-react';
import { TOKEN_BLOCKS } from '@/lib/tokenBlocks';
import { startTokenCheckout } from '@/lib/purchaseCredits';
import { useToast } from '@/components/ui/use-toast';

// Global, always-mounted popup (see App.jsx) for the one failure mode every
// credit-consuming action can hit: InsufficientCreditsError
// (server/src/lib/billing.js), surfaced as a 402 with code
// 'INSUFFICIENT_CREDITS' from whichever function endpoint hit it.
// src/api/base44Client.js's apiFetch() dispatches a window CustomEvent for
// that specific case (in addition to still throwing normally), so this pops
// up regardless of which of the many credit-consuming actions — chat,
// autonomous build step, test generation, backend generation, self-dev,
// compile — triggered it, without every one of those call sites needing its
// own copy of this UI. Existing per-call-site error handling (e.g.
// useWorkspace.js's inline chat error message) is unaffected; this is
// purely additive.
const EVENT_NAME = 'morpheus:insufficient-credits';

export default function InsufficientCreditsModal() {
  const [detail, setDetail] = useState(null); // { needed, available, message } | null
  const [buyingIndex, setBuyingIndex] = useState(null);
  const [error, setError] = useState('');
  const { toast } = useToast();

  useEffect(() => {
    const onInsufficientCredits = (e) => {
      setError('');
      setBuyingIndex(null);
      setDetail(e.detail || {});
    };
    window.addEventListener(EVENT_NAME, onInsufficientCredits);
    return () => window.removeEventListener(EVENT_NAME, onInsufficientCredits);
  }, []);

  // Stripe Checkout can return to any page (whichever one was open when a
  // buy button here — or in CreditBalance.jsx — redirected out), so this
  // runs on every page load rather than just Settings. CreditBalance.jsx
  // still shows its own inline banner when it happens to be mounted; a toast
  // here covers every other page. Harmless if both fire on the same page.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const credits = params.get('credits');
    if (credits !== 'success' && credits !== 'cancelled') return;
    if (credits === 'success') {
      toast({ title: 'Payment received', description: 'Your credit balance updates within a few seconds.' });
    }
    params.delete('credits');
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : '');
    window.history.replaceState({}, '', cleanUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(() => {
    setDetail(null);
    setError('');
    setBuyingIndex(null);
  }, []);

  const buy = async (blockIndex) => {
    setError('');
    setBuyingIndex(blockIndex);
    try {
      await startTokenCheckout(blockIndex);
      // Navigates away on success — nothing else to do here.
    } catch (e) {
      setError(e.message || 'Could not start checkout');
      setBuyingIndex(null);
    }
  };

  if (!detail) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4">
      <div className="bg-background border border-primary/40 max-w-md w-full p-5 font-mono">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 text-yellow-500">
            <AlertTriangle size={18} />
            <span className="font-display tracking-wider">OUT OF CREDITS</span>
          </div>
          <button onClick={close} className="text-primary/50 hover:text-primary shrink-0" aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
        <p className="text-ink text-sm mb-4 leading-relaxed">
          {detail.message || "This action needs more credits than your account currently has."}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {TOKEN_BLOCKS.map((block, i) => (
            <button
              key={block.credits}
              onClick={() => buy(i)}
              disabled={buyingIndex !== null}
              className="text-left border border-primary/20 hover:border-primary/50 p-3 transition-colors disabled:opacity-40"
            >
              <div className="text-xs font-display tracking-wider text-primary flex items-center gap-1.5">
                <Coins size={12} /> {block.credits.toLocaleString()} CREDITS
              </div>
              <div className="text-[10px] text-ink-max mt-1">~${block.intendedNetUsd.toFixed(2)} + card fees</div>
              <div className="mt-2 flex items-center gap-1.5 text-xs text-ink-strong">
                {buyingIndex === i ? <Loader2 size={12} className="animate-spin" /> : null}
                {buyingIndex === i ? 'Redirecting…' : 'Buy'}
              </div>
            </button>
          ))}
        </div>
        {error && <p className="text-red-400 text-xs mt-3">// {error}</p>}
        <p className="text-[10px] text-ink-max mt-3">
          // Secure checkout via Stripe. You'll come back here once it's done.
        </p>
      </div>
    </div>
  );
}
