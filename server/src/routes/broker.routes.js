// The metering endpoints the Morpheus Cloud broker calls, and the one an account calls to get a token.
//
// WHY THIS ROUTE EXISTS. `hosted-broker/` proxies AI for self-hosted instances that have no key of
// their own, and until now the only thing deciding who could use it was a shared token list in the
// broker's own env — so every install spent the operator's money with no billing and no per-person
// cap. Its own README says as much: "swap in real per-tenant metering/billing before relying on it at
// any real scale". These endpoints make the DEPLOYMENT the authority: it mints a token per account,
// says whether that account may spend, and records what it spent, in the product's own ledger and at
// the product's own prices.
//
// FOUR ENDPOINTS, two audiences:
//   POST /api/broker/token    a signed-in account mints a gateway token for its own install (7 days)
//   POST /api/broker/verify   the BROKER reserves credits before a call and gets a ticket for it
//   POST /api/broker/usage    the BROKER reports what the call used, redeeming that ticket
//   POST /api/broker/refund   the BROKER gives a reservation back when the call never ran
//
// VERIFY RESERVES, IT DOES NOT CHECK. Asking "does the balance cover this?" and charging afterwards is
// the exact race `reserveCredits` exists to close: two calls in flight both see a balance that covers
// one of them, and the account is served twice and ends at zero. So verify debits the estimate with
// reserveCredits' atomic conditional UPDATE (402 with no overdraft grace, exactly as ai.js does it),
// and the reserved amount travels back to the broker inside a signed 5-minute ticket — bounded in
// size, forgery-proof, and the only thing usage will redeem.
//
// The broker authenticates with a shared secret (BROKER_INTERNAL_SECRET) compared in constant time,
// never with an account's session — a broker is not a user and must not be able to act as one. The
// account's own token travels in a request body, never a query string, so it cannot land in an access
// log.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { optionalAuth } from '../auth.js';
import { sameToken } from '../lib/tokenHash.js';
import {
  reserveCredits, reconcileCredits, resolveBillingRate, resolveBillingMarkup, usdToCredits,
  CREDIT_RATE_USD, ESTIMATE_SAFETY_MULTIPLIER, CHARS_PER_TOKEN,
} from '../lib/billing.js';
import { getModelRate, computeCostUsd } from '../lib/modelPricing.js';
import { shouldReserveCredits } from '../lib/creditPolicy.js';
import {
  mintGatewayToken, verifyGatewayToken, mintReservationTicket, verifyReservationTicket,
  estimateCallCredits, usageFromResponse, BROKER_SECRET_HEADER, CLOUD_PROVIDER, REFUSALS,
} from '../lib/cloudMetering.js';
import { resolveTokenMint, mintResponse } from '../lib/brokerMinting.js';

const router = express.Router();

const signingSecret = () => process.env.BROKER_GATEWAY_SIGNING_SECRET || '';

/**
 * The signed-in account on this request, or null. `optionalAuth` is what makes the token route able
 * to serve BOTH audiences — a session minting for itself, and the install's own server naming the
 * account it serves — without the session path having to exist twice.
 */
const sessionUserIdOf = (req) => req.user?.id || null;
const internalSecret = () => process.env.BROKER_INTERNAL_SECRET || '';

/** The output cap a brokered call is reserved against, and the ceiling the broker enforces upstream. */
const MAX_OUTPUT_TOKENS = 8_000;
/** The prompt length past which a request is refused rather than reserved against. */
const MAX_PROMPT_CHARS = 400_000;

/**
 * Is this request from the broker? Constant-time, and refuses when either side is unset — a
 * deployment that never configured a secret must not accept anonymous usage reports, which would let
 * anyone write charge rows against any account.
 */
function isBroker(req) {
  const secret = internalSecret();
  if (!secret) return false;
  return sameToken(req.get(BROKER_SECRET_HEADER) || '', secret);
}

/**
 * One reservation, one redemption. In-process and bounded, NOT durable: a restart inside the ticket's
 * 5-minute life forgets which tickets were redeemed, and a replayed ticket can then refund the same
 * reservation twice, in the account's favour, until the balance is where it started. That is a real
 * gap and it is written down in cloudMetering.js's METERING_CAVEATS rather than papered over — the
 * durable version is the broker_gateway_tokens row that would also give per-token revocation.
 */
const redeemedReservations = new Map(); // reservationId -> redeemedAt (ms)
const MAX_TRACKED_RESERVATIONS = 20_000;
function claimReservation(id, now) {
  const cutoff = now - 5 * 60 * 1000;
  for (const [key, at] of redeemedReservations) {
    if (at < cutoff) redeemedReservations.delete(key);
  }
  if (!id) return true; // a legacy ticket with no jti cannot be deduplicated; expiry is its bound
  if (redeemedReservations.has(id)) return false;
  if (redeemedReservations.size >= MAX_TRACKED_RESERVATIONS) {
    const oldest = redeemedReservations.keys().next().value;
    redeemedReservations.delete(oldest);
  }
  redeemedReservations.set(id, now);
  return true;
}

/** Rate-limit the broker endpoints per IP: a compromised broker must not be able to hammer the ledger. */
const brokerLimit = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });

/** The account fields every one of these endpoints needs, and nothing else. */
const ACCOUNT_FIELDS = { id: true, role: true, billing_exempt: true, credit_balance: true };

const balanceOf = (user) => Number(user?.credit_balance ?? 0);

/** One UsageEvent row, in the shape ai.js's recordUsageEvent writes and billingLedger.js audits. */
async function recordBrokerUsage({ accountId, model, inputTokens, outputTokens, creditsCharged, durationMs }) {
  try {
    const costUsd = computeCostUsd(inputTokens, outputTokens, await getModelRate(model));
    await prisma.usageEvent.create({
      data: {
        created_by_id: accountId,
        role: null, // a brokered call is not one of the product's roles
        provider: CLOUD_PROVIDER,
        model_id: model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        credits_charged: creditsCharged,
        task: 'broker-gateway',
        status: 'ok',
        duration_ms: Number.isFinite(durationMs) ? durationMs : null,
      },
    });
  } catch (err) {
    // Table missing on an unmigrated DB, or the write failed — metering must never break a call the
    // user already has the answer to. The credits were already reconciled; only the record is lost.
    console.error('[broker] usage event write failed:', err.message);
  }
}

// ── the account's side: mint a token for an install ─────────────────────────
// Two ways in, and which one applies is decided by lib/brokerMinting.js rather than inline here:
//   * a signed-in account, minting for itself (the Settings/CLI path); and
//   * the install's own server, presenting the broker secret and naming the account it is serving —
//     which is how the gateway token reaches the AI tier without anyone pasting one into an env file.
// Deliberately NOT requireAuth: that middleware would 401 the second caller, and an install minting a
// token for its own operator is the normal case on a single-tenant install, not an escalation.
router.post('/token', optionalAuth, async (req, res, next) => {
  try {
    if (!signingSecret()) {
      return res.status(503).json({ error: 'This deployment has no BROKER_GATEWAY_SIGNING_SECRET set, so it cannot issue gateway tokens.' });
    }
    const verdict = resolveTokenMint({
      internalSecretMatches: isBroker(req),
      sessionUserId: sessionUserIdOf(req),
      requestedAccountId: req.body?.accountId,
    });
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

    if (verdict.via === 'broker') {
      const account = await prisma.user.findUnique({ where: { id: verdict.accountId }, select: { id: true } });
      if (!account) return res.status(404).json({ error: REFUSALS.noAccount });
    }

    const { token, expiresAt } = mintGatewayToken({ accountId: verdict.accountId, secret: signingSecret() });
    // Returned once, to the caller that just authenticated, and never logged.
    res.json(mintResponse({ token, expiresAt, provider: CLOUD_PROVIDER }));
  } catch (err) { next(err); }
});

// ── the broker's side ───────────────────────────────────────────────────────
router.post('/verify', brokerLimit, async (req, res, next) => {
  try {
    if (!isBroker(req)) return res.status(401).json({ error: 'broker secret required' });
    const verdict = verifyGatewayToken({ token: req.body?.token, secret: signingSecret() });
    if (!verdict.ok) return res.status(403).json({ ok: false, reason: verdict.reason });

    const user = await prisma.user.findUnique({ where: { id: verdict.accountId }, select: ACCOUNT_FIELDS });
    if (!user) return res.status(403).json({ ok: false, reason: REFUSALS.noAccount });

    // Exempt means "don't charge", never "don't meter" — so an exempt account still gets a ticket and
    // still gets a usage row, with reservedCredits 0.
    if (!shouldReserveCredits(user)) {
      const ticket = mintReservationTicket({ accountId: user.id, reservedCredits: 0, secret: signingSecret() });
      return res.json({ ok: true, accountId: user.id, exempt: true, reservedCredits: 0, remainingCredits: balanceOf(user), ticket: ticket.token, ticketExpiresAt: ticket.expiresAt, maxOutputTokens: MAX_OUTPUT_TOKENS });
    }

    const model = String(req.body?.model || '');
    const [rate, markup] = await Promise.all([resolveBillingRate(model), resolveBillingMarkup(model)]);
    const reservedCredits = estimateCallCredits({
      promptChars: Math.min(Number(req.body?.promptChars) || 0, MAX_PROMPT_CHARS),
      maxTokens: Math.min(Number(req.body?.maxOutputTokens) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
      inputPerM: rate.inputPerM,
      outputPerM: rate.outputPerM,
      markup,
      safety: ESTIMATE_SAFETY_MULTIPLIER,
      charsPerToken: CHARS_PER_TOKEN,
    });

    // Atomic: two concurrent calls cannot both pass a balance check that only one of them should.
    try {
      await reserveCredits(user.id, reservedCredits);
    } catch (err) {
      if (err?.name === 'InsufficientCreditsError' || err?.status === 402) {
        return res.status(402).json({ ok: false, reason: REFUSALS.noCredits, remainingCredits: Number(err.available ?? balanceOf(user)), neededCredits: Number(err.needed ?? reservedCredits) });
      }
      throw err;
    }

    const ticket = mintReservationTicket({ accountId: user.id, reservedCredits, secret: signingSecret() });
    const after = await prisma.user.findUnique({ where: { id: user.id }, select: { credit_balance: true } });
    res.json({
      ok: true, accountId: user.id, exempt: false,
      reservedCredits, remainingCredits: balanceOf(after), model,
      ticket: ticket.token, ticketExpiresAt: ticket.expiresAt, maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (err) { next(err); }
});

/**
 * Redeem a reservation against what the call actually used. The ticket, not the gateway token, is
 * what proves the reservation — so a broker that skipped verify has nothing to charge against.
 */
router.post('/usage', brokerLimit, async (req, res, next) => {
  try {
    if (!isBroker(req)) return res.status(401).json({ error: 'broker secret required' });
    const verdict = verifyReservationTicket({ token: req.body?.ticket, secret: signingSecret() });
    if (!verdict.ok) return res.status(403).json({ ok: false, reason: verdict.reason });
    if (!claimReservation(verdict.reservationId, Date.now())) {
      return res.status(409).json({ ok: false, reason: 'that reservation has already been reported — one reservation settles one call' });
    }

    const usage = usageFromResponse({ usage: { prompt_tokens: req.body?.inputTokens, completion_tokens: req.body?.outputTokens } });
    if (!usage) return res.status(400).json({ ok: false, reason: 'inputTokens and outputTokens are required — a call nobody measured is not a free one' });

    const user = await prisma.user.findUnique({ where: { id: verdict.accountId }, select: ACCOUNT_FIELDS });
    if (!user) return res.status(403).json({ ok: false, reason: REFUSALS.noAccount });

    const model = String(req.body?.model || 'brokered');
    const exempt = !shouldReserveCredits(user);
    const [rate, markup] = await Promise.all([resolveBillingRate(model), resolveBillingMarkup(model)]);

    // NOT a flat-rated call, deliberately, even for a model on creditPolicy.js's FLAT_RATE_MODELS.
    //
    // The flat 1 credit exists because for an own-key or locally hosted call the inference is not
    // ours: what is left to cover is our plumbing, so a token price would be both wrong and
    // inexplicable. Here it is the opposite — this gateway holds the upstream key, so the operator
    // pays that model's real inference bill and the call must be priced from the tokens it used.
    //
    // It is worth naming how this was found, because every guard was green: the first version asked
    // `isFlatRateCall({ provider: CLOUD_PROVIDER, model })`, and that rule requires an OWN-KEY
    // provider, so it returned false for every brokered call — while the guard asserting "the flat
    // rate is applied" passed, because it matched a comment and an identifier rather than the branch.
    // Booting the server and calling it charged a 49k-token gemini call 0.28 credits. See
    // scripts/verify-cloud-metering.mjs section 5, which now asserts the token price instead.
    let charged = 0;
    if (!exempt) {
      charged = usdToCredits(computeCostUsd(usage.inputTokens, usage.outputTokens, rate), markup);
      try {
        await reconcileCredits(user.id, verdict.reservedCredits, charged);
      } catch (err) {
        // The reservation already happened; a failed true-up leaves a stale balance that the next
        // call's reservation still enforces. Never break the reply the user already has.
        console.error('[broker] reconcile failed:', err.message);
      }
    }

    await recordBrokerUsage({ accountId: user.id, model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, creditsCharged: charged, durationMs: req.body?.durationMs });

    const after = await prisma.user.findUnique({ where: { id: user.id }, select: { credit_balance: true } }).catch(() => null);
    res.json({
      ok: true, accountId: user.id, model, provider: CLOUD_PROVIDER, exempt, pricedBy: exempt ? 'exempt' : 'tokens',
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      reservedCredits: verdict.reservedCredits, creditsCharged: charged,
      refundedCredits: Math.max(0, Number((verdict.reservedCredits - charged).toFixed(4))),
      creditRateUsd: CREDIT_RATE_USD,
      remainingCredits: balanceOf(after ?? user),
    });
  } catch (err) { next(err); }
});

/**
 * Give a reservation back when the call never reached the model. Without this, every failed upstream
 * call would keep its estimate — an over-charge that reconciliation can never correct, because no
 * usage was ever reported. Idempotent for the same reason usage is: one reservation, one settlement.
 */
router.post('/refund', brokerLimit, async (req, res, next) => {
  try {
    if (!isBroker(req)) return res.status(401).json({ error: 'broker secret required' });
    const verdict = verifyReservationTicket({ token: req.body?.ticket, secret: signingSecret() });
    if (!verdict.ok) return res.status(403).json({ ok: false, reason: verdict.reason });
    if (!claimReservation(verdict.reservationId, Date.now())) {
      return res.status(409).json({ ok: false, reason: 'that reservation has already been settled — one reservation settles one call' });
    }

    let refunded = 0;
    if (verdict.reservedCredits > 0) {
      await reconcileCredits(verdict.accountId, verdict.reservedCredits, 0);
      refunded = verdict.reservedCredits;
    }
    const after = await prisma.user.findUnique({ where: { id: verdict.accountId }, select: { credit_balance: true } }).catch(() => null);
    res.json({ ok: true, accountId: verdict.accountId, refundedCredits: refunded, reason: req.body?.reason || null, remainingCredits: balanceOf(after) });
  } catch (err) { next(err); }
});

export default router;
