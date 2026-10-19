// Purchasable token-block denominations — display copy only. The
// authoritative source of truth (the price actually charged) is always
// server/src/lib/billing.js's TOKEN_BLOCKS; createTokenCheckout.js looks the
// real price up there server-side from the block *index* the client sends,
// so a stale or tampered value here can never under-charge — see that
// file's comment for the full pricing derivation ($2/$4/$8 net, grossed up
// for Stripe's fee).
//
// Two frontend consumers share this one array (CreditBalance.jsx's Settings
// purchase UI, InsufficientCreditsModal.jsx's global out-of-credits popup,
// both 2026-09-02) so there's exactly one place to update if billing.js's
// blocks ever change again, instead of each screen keeping its own copy.
export const TOKEN_BLOCKS = [
  { credits: 400, intendedNetUsd: 2.00 },
  { credits: 800, intendedNetUsd: 4.00 },
  { credits: 1600, intendedNetUsd: 8.00 },
];
