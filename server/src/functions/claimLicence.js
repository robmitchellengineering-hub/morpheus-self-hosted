// claimLicence — turn a paid Stripe checkout into a licence owned by the signed-in account.
//
// U-11, Rob's flow: checkout success redirects to /claim?session_id=… rather than emailing a code. The session
// id is the bearer token — unguessable, single-use — and this function is the only thing that may spend it.
//
// WHAT THIS FUNCTION REFUSES, and why each refusal exists (all decided in licencePolicy.claimDecision, which
// the guards job proves without Stripe):
//   no session      401  you must be signed in: a licence is owned by an account
//   unknown session 404  a made-up id
//   unpaid          402  a session that was created and abandoned mints nothing
//   someone else's  409  a leaked success URL must not read another account's licence
//
// IDEMPOTENT BY CONSTRUCTION. `licences.stripe_session_id` is UNIQUE, so a refresh of the claim page — or two
// tabs at once — returns the same licence instead of minting a second one. The database, not this function,
// is what guarantees that.
//
// WHAT IS NEVER TRUSTED: the body. The package and seat count come from the Stripe session's metadata, which
// only this deployment wrote. A client that posts "plan: team, seats: 99" changes nothing.
import { prisma } from '../db.js';
import { stripeFetch } from '../lib/stripe.js';
import { buildClaims, claimsFromRow, issuerKeyPemAsync, signLicence } from '../lib/licenceKey.js';
import { claimDecision, licenceForPackage } from '../lib/licencePolicy.js';

// The published feed. Env override so a staging deployment can point at its own copy.
// THE FEED IS SERVED BY THE API, TO A LICENCE — not by the marketing site to anybody with the URL.
/**
 * Sign with the deployment's key, WHEREVER IT LIVES.
 *
 * `signLicence()` alone reads the environment only. This deployment can hold the key in Supabase Vault (#739/#741), and
 * the Stripe webhook already resolves it that way — so an endpoint calling the sync signer answers 503 on a Vault
 * deployment while renewals sign happily in the same process. One resolver, used by every path that mints.
 */
async function signWithDeploymentKey(db, claims) {
  const { pem } = await issuerKeyPemAsync(db);
  if (!pem) {
    throw Object.assign(
      new Error('No licence signing key on this deployment — set VVS_ISSUER_KEY_PEM, or store vvs_issuer_key in Supabase Vault.'),
      { status: 503 },
    );
  }
  return signLicence(claims, pem);
}

const CORPUS_FEED_URL = process.env.VVS_CORPUS_FEED_URL || 'https://api.morpheus.nz/api/functions/vvsFeed';

export default async function handler({ user, body }) {
  const sessionId = String(body?.sessionId || '').trim();
  if (!sessionId) {
    throw Object.assign(new Error('No checkout session was given.'), { status: 400 });
  }

  // Read the session from Stripe, never from the request. A failure here is a cannot-check: refusing is the
  // only safe answer, because the alternative is minting a licence for a purchase we could not confirm.
  let session = null;
  try {
    session = await stripeFetch(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
  } catch {
    throw Object.assign(new Error('Could not confirm that checkout with Stripe. Nothing was issued.'), { status: 502 });
  }

  const existing = await prisma.licence.findUnique({ where: { stripe_session_id: sessionId } });

  const verdict = claimDecision({ session, existing, user });
  if (!verdict.ok) {
    throw Object.assign(new Error(verdict.reason), { status: verdict.status });
  }

  if (verdict.action === 'return') {
    // Derive the token from the row rather than storing it (the token is never at rest in this table).
    return { licence: await signWithDeploymentKey(prisma, claimsFromRow(existing)), plan: existing.plan, seats: existing.seats, state: 'already-claimed' };
  }

  const pkg = session?.metadata?.package;
  const bought = licenceForPackage(pkg, session?.metadata?.seats);
  if (!bought) throw Object.assign(new Error('That checkout is not a licence or a corpus subscription.'), { status: 422 });

  // A CORPUS TIER IS A LICENCE WITH THE FEED ON IT. It used to return a bare URL to a public file, so the buyer paid
  // $500 and received neither a licence nor anything exclusive. Now the same mint runs, the entitlement rides in the
  // claims, and the feed URL is the endpoint that checks it. (Rob, 2026-11-04: the tiers are additive and all include
  // the SDK.)
  // Sign BEFORE writing: no key means 503 and no row, so a licence that cannot be verified never looks issued.
  const claims = buildClaims({ accountId: user.id, plan: bought.plan, seats: bought.seats, days: 365, feed: bought.feed });
  const token = await signWithDeploymentKey(prisma, claims);

  try {
    await prisma.licence.create({
      data: {
        created_by_id: user.id,
        jti: claims.jti,
        plan: claims.plan,
        seats: claims.seats,
        kid: claims.kid,
        issued_at: new Date(claims.iat * 1000),
        expires_at: new Date(claims.exp * 1000),
        stripe_session_id: sessionId,
        note: `claimed from checkout ${sessionId}`,
      },
    });
  } catch (e) {
    // The unique index is the idempotency guarantee: two simultaneous claims, one of them loses here and
    // must return the winner's licence rather than a 500.
    if (String(e?.code) === 'P2002') {
      const won = await prisma.licence.findUnique({ where: { stripe_session_id: sessionId } });
      if (won && won.created_by_id === user.id) {
        return { licence: await signWithDeploymentKey(prisma, claimsFromRow(won)), plan: won.plan, seats: won.seats, state: 'already-claimed' };
      }
    }
    throw e;
  }

  // A corpus buyer gets BOTH: the licence (which the tool needs) and the feed URL the licence unlocks.
  return {
    licence: token,
    plan: claims.plan,
    seats: claims.seats,
    state: 'issued',
    ...(bought.feed ? { feed: bought.feed, feedUrl: CORPUS_FEED_URL } : {}),
  };
}
