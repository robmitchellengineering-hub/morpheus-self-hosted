// Metering for the Morpheus Cloud gateway: whose account a brokered call belongs to, and what it costs.
//
// WHY THIS EXISTS. `hosted-broker/` holds the operator's own upstream AI key so a freshly self-hosted
// Morpheus gets working AI with no key of its own. Its own README says what that gate currently is:
// "simple bearer deployment tokens and a per-token rate limit … swap in real per-tenant
// metering/billing before relying on it at any real scale". A shared token list means everyone who has
// one spends the operator's money with no billing and no per-person cap — the "paid default" in name.
//
// This module is the rule that makes it paid: a token belongs to an ACCOUNT, the account's balance is
// checked before the call, and the call is charged afterwards using the same pricing the product
// already uses. The app is the authority for all three, so the broker asks it rather than deciding.
//
// NO NEW TABLE, ON PURPOSE. The token is signed and self-describing (`mgw_<payload>.<sig>`), verified
// by the app on every call. That keeps the change out of production DDL entirely, at the cost of
// per-token revocation: a leaked token is bounded by its expiry and by the account's balance, and
// cutting it off early needs a stored token record. Recorded here rather than discovered later, and
// the follow-up is a `broker_gateway_tokens` row (hash, label, last_used_at, revoked_at).
import crypto from 'node:crypto';
import { sameToken } from './tokenHash.js';

/** Prefixed like this repo's other bearer kinds (`wgt_`, `dvc_`, `opr_`, `apc_`). */
export const TOKEN_PREFIX = 'mgw_';

/**
 * How long a gateway token lives. Deliberately short: it is the only bound on a leaked token until
 * revocation exists, and a portable install can re-mint from its account in one command.
 */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The header the broker authenticates ITSELF with when it calls the app (never the account's token). */
export const BROKER_SECRET_HEADER = 'x-morpheus-broker-secret';

/** The `provider` recorded on usage rows for a call that ran through the broker. */
export const CLOUD_PROVIDER = 'morpheus-cloud';

/**
 * Reservation tickets — the second token kind, and the reason a brokered call cannot spend past zero.
 *
 * A CHECK IS NOT A RESERVATION. The first version of this gateway asked "does the balance cover the
 * estimate?" and answered the call afterwards, which is exactly the race `reserveCredits` exists to
 * close: two calls in flight both see a balance that covers one of them, and the account ends at zero
 * having been served twice. So verification RESERVES — it debits the estimate with `reserveCredits`'
 * atomic conditional UPDATE — and hands the broker a short-lived signed ticket recording what was
 * taken. The broker reports usage against that ticket, and the true-up refunds the difference.
 *
 * The reserved amount lives INSIDE the signature, so the broker cannot report against a reservation
 * it did not make, and a ticket is good for one call and a few minutes — the window in which the
 * upstream could still be running. `chargeFor` is the same arithmetic as `billingLedger.js`'s
 * `expectedCharge`, so what a ticket authorises and what the row records agree by construction.
 */
export const RESERVATION_PREFIX = 'mgr_';

/** How long a reservation ticket lives: long enough for a slow completion, short enough to be boring. */
export const RESERVATION_TTL_MS = 5 * 60 * 1000;

/** Ticket ids are random, so a replayed ticket is recognisably the same ticket. */
const newTicketId = () => b64url(crypto.randomBytes(12));

/**
 * Mint the reservation ticket returned by verify and redeemed by usage. `reservedCredits` must be
 * finite and non-negative — a ticket authorising a negative amount would be a refund the account
 * never earned.
 */
export function mintReservationTicket({ accountId, reservedCredits, secret, now = Date.now(), ttlMs = RESERVATION_TTL_MS }) {
  if (!accountId) throw new Error('mintReservationTicket needs an accountId');
  if (!secret) throw new Error('mintReservationTicket needs a signing secret');
  const reserved = Number(reservedCredits);
  if (!Number.isFinite(reserved) || reserved < 0) throw new Error('mintReservationTicket needs a non-negative reservedCredits');
  const ttl = Math.min(Number(ttlMs) || RESERVATION_TTL_MS, RESERVATION_TTL_MS);
  const payload = b64url(JSON.stringify({ sub: String(accountId), rsv: reserved, jti: newTicketId(), iat: now, exp: now + ttl }));
  const sig = b64url(crypto.createHmac('sha256', String(secret)).update(payload).digest());
  return { token: `${RESERVATION_PREFIX}${payload}.${sig}`, reservationId: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).jti, reservedCredits: reserved, expiresAt: new Date(now + ttl).toISOString() };
}

/**
 * Verify a reservation ticket. Returns `{ ok: true, accountId, reservedCredits, reservationId }`, or
 * `{ ok: false, reason }` with a REFUSALS sentence.
 *
 * It shares `REFUSALS.malformed`/`signature`/`expired` with the gateway token deliberately: from the
 * broker's side a bad credential is a bad credential, and the broker relays the sentence verbatim.
 */
export function verifyReservationTicket({ token, secret, now = Date.now() }) {
  const raw = String(token || '');
  if (!raw.startsWith(RESERVATION_PREFIX)) return { ok: false, reason: REFUSALS.malformed };
  const [payload, sig] = raw.slice(RESERVATION_PREFIX.length).split('.');
  if (!payload || !sig) return { ok: false, reason: REFUSALS.malformed };
  const expected = b64url(crypto.createHmac('sha256', String(secret || '')).update(payload).digest());
  if (!sameToken(sig, expected)) return { ok: false, reason: REFUSALS.signature };

  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: REFUSALS.malformed };
  }
  if (!body?.sub || !Number.isFinite(body?.exp) || !Number.isFinite(body?.rsv)) return { ok: false, reason: REFUSALS.malformed };
  if (now >= body.exp) return { ok: false, reason: REFUSALS.expired };
  return { ok: true, accountId: String(body.sub), reservedCredits: Number(body.rsv), reservationId: String(body.jti || '') };
}

/** Refusal reasons, so the broker can say something specific instead of "forbidden". */
export const REFUSALS = {
  malformed: 'that gateway token is not in the expected format',
  signature: 'that gateway token was not issued by this deployment',
  expired: 'that gateway token has expired — mint a new one from your Morpheus account',
  noAccount: 'that gateway token names an account this deployment does not have',
  noCredits: 'this account does not have enough credits for another call',
  streaming: 'streaming replies cannot be metered, so this gateway does not serve them',
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Mint a gateway token for an account. `secret` comes from the deployment's env, never the database.
 * `ttlMs` is clamped to DEFAULT_TTL_MS so a caller cannot mint an effectively permanent credential.
 */
export function mintGatewayToken({ accountId, secret, now = Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  if (!accountId) throw new Error('mintGatewayToken needs an accountId');
  if (!secret) throw new Error('mintGatewayToken needs a signing secret');
  const ttl = Math.min(Number(ttlMs) || DEFAULT_TTL_MS, DEFAULT_TTL_MS);
  const payload = b64url(JSON.stringify({ sub: String(accountId), iat: now, exp: now + ttl }));
  const sig = b64url(crypto.createHmac('sha256', String(secret)).update(payload).digest());
  return { token: `${TOKEN_PREFIX}${payload}.${sig}`, expiresAt: new Date(now + ttl).toISOString() };
}

/**
 * Verify a gateway token. Returns `{ ok: true, accountId }` or `{ ok: false, reason }` where reason is
 * one of REFUSALS — the broker relays that sentence rather than inventing one.
 *
 * The signature is compared with the repo's shared constant-time helper, so a wrong guess leaks
 * nothing about how close it was. Expiry is checked here rather than trusted from the payload's
 * presence, because a token without a readable `exp` is a token nobody can bound.
 */
export function verifyGatewayToken({ token, secret, now = Date.now() }) {
  const raw = String(token || '');
  if (!raw.startsWith(TOKEN_PREFIX)) return { ok: false, reason: REFUSALS.malformed };
  const [payload, sig] = raw.slice(TOKEN_PREFIX.length).split('.');
  if (!payload || !sig) return { ok: false, reason: REFUSALS.malformed };
  const expected = b64url(crypto.createHmac('sha256', String(secret || '')).update(payload).digest());
  if (!sameToken(sig, expected)) return { ok: false, reason: REFUSALS.signature };

  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: REFUSALS.malformed };
  }
  if (!body?.sub || !Number.isFinite(body?.exp)) return { ok: false, reason: REFUSALS.malformed };
  if (now >= body.exp) return { ok: false, reason: REFUSALS.expired };
  return { ok: true, accountId: String(body.sub) };
}

/**
 * May this account make another brokered call? Exempt accounts (the operator, an explicit grant) are
 * allowed and charged nothing — the same rule the rest of the product applies, so a self-host
 * operator's own install is not billed by the gateway they run.
 */
export function authorizeCloudCall({ account, remainingCredits, estimateCredits, exempt }) {
  if (!account) return { ok: false, reason: REFUSALS.noAccount };
  if (exempt) return { ok: true, exempt: true };
  // The estimate is the pre-call reservation the product already does for a platform-key call, so a
  // brokered call cannot be the one path that lets an account spend past zero.
  if (Number(remainingCredits || 0) < Number(estimateCredits || 0)) return { ok: false, reason: REFUSALS.noCredits };
  return { ok: true, exempt: false };
}

/**
 * What a metered call costs, in credits — the SAME arithmetic as `billingLedger.js`'s `expectedCharge`
 * (tokens × rate × markup ÷ $0.005), which the credential-requiring ledger check validates against
 * production rows. It takes rate and markup as inputs because resolving them needs the database; the
 * guard asserts this agrees with `expectedCharge` for the same numbers rather than trusting a copy.
 */
export function chargeFor({ inputTokens, outputTokens, inputPerM, outputPerM, markup }) {
  const usd = (Number(inputTokens || 0) * Number(inputPerM || 0) + Number(outputTokens || 0) * Number(outputPerM || 0)) / 1_000_000;
  return Math.round(((usd * Number(markup || 0)) / 0.005) * 10000) / 10000;
}

/**
 * Token counts from an OpenAI-compatible response. Returns null when the upstream did not report them:
 * an unmetered call is not a free one, so the caller must treat null as "do not serve this".
 */
export function usageFromResponse(body) {
  const usage = body?.usage;
  const input = usage?.prompt_tokens;
  const output = usage?.completion_tokens;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { inputTokens: input, outputTokens: output };
}

/**
 * The reservation for one brokered call, in credits — the product's own pre-call estimate, reused
 * rather than reimplemented. `promptChars` is the only thing the gateway knows about the input before
 * the call runs; the estimate converts it with the same chars-per-token heuristic a platform-key call
 * uses, so a brokered call is reserved on the same basis as every other call.
 *
 * `safety` is passed in (billing.js's ESTIMATE_SAFETY_MULTIPLIER) rather than duplicated here, so a
 * change to the reservation policy cannot leave this path quietly under-reserving.
 */
export function estimateCallCredits({ promptChars, maxTokens, inputPerM, outputPerM, markup, safety = 1.4, charsPerToken = 4 }) {
  const inputTokens = Math.ceil(Number(promptChars || 0) / charsPerToken);
  const outputTokens = Number(maxTokens || 0);
  const usd = (inputTokens * Number(inputPerM || 0) + outputTokens * Number(outputPerM || 0)) / 1_000_000;
  return Math.round(((usd * Number(markup || 0) * Number(safety || 0)) / 0.005) * 10000) / 10000;
}

/**
 * What cannot be done yet, stated where the code that would do it lives. A billed surface that hides
 * its own gap is how "paid" becomes a word nobody checked.
 */
export const METERING_CAVEATS = [
  'A gateway token cannot be revoked individually yet: it is bounded by its expiry (7 days) and by the account\'s balance, and a stolen one is cut off only when it expires. Per-token revocation needs a stored token record — a broker_gateway_tokens row (hash, label, last_used_at, revoked_at) is the follow-up.',
  'The broker verifies and charges through this deployment on every call, so the deployment must be reachable from the broker for the gateway to work at all.',
  'Streaming responses are refused rather than served unmetered.',
  'A call that is verified but never reported keeps its reservation: the estimate stays debited until the ticket is redeemed. That is the same exposure the platform-key path already carries between reserveCredits and recordUsageEvent — the direction of error is in the platform\'s favour, which is the safe one, but it is not a true-up and a crashed broker mid-call leaves it behind.',
  'Replay of one reservation ticket is bounded by its 5-minute expiry and by the app\'s in-process nonce set, not by a stored record — a restart inside that window would forget it. The durable fix is the same broker_gateway_tokens row.',
];
