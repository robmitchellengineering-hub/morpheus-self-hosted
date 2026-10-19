// Starts a token-block purchase via Stripe Checkout. Shared by
// CreditBalance.jsx (Settings page) and InsufficientCreditsModal.jsx (global
// out-of-credits popup, 2026-09-02) so both kick off checkout identically
// instead of each keeping its own copy of this logic.
//
// successUrl/cancelUrl deliberately return to whatever page the buyer was
// actually on (window.location.pathname), not a fixed page — the popup can
// open from anywhere (mid-chat on Workspace, self-dev, autonomous build...),
// and the buyer should land back where they were, not get redirected to
// Settings. See src/lib/tokenBlocks.js for the block list this indexes into.
import { base44 } from '@/api/base44Client';

export async function startTokenCheckout(blockIndex) {
  const origin = window.location.origin;
  const path = window.location.pathname;
  const res = await base44.functions.invoke('createTokenCheckout', {
    blockIndex,
    successUrl: `${origin}${path}?credits=success`,
    cancelUrl: `${origin}${path}?credits=cancelled`,
  });
  if (res.data?.url) {
    window.location.href = res.data.url;
    return;
  }
  throw new Error('Could not start checkout');
}
