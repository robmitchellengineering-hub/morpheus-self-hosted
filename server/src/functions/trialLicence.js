// trialLicence.js — the free trial, issued by Morpheus to a signed-in account.
//
// WHY IT NEEDS A LOGIN (Rob, 2026-11-04: "it needs a login to get the trial"). The alternative was a static
// licence file on the marketing site, which every visitor downloaded and which was the same token for all of
// them: not issued, not attributable, not revocable, and expiring for the whole world on one date. A trial is a
// licence like any other — it is minted under an account, from the deployment's key, and appears on
// `/licences` where it can be revoked like one.
//
// ONE PER ACCOUNT. `stripe_session_id` is unique and NULLABLE precisely so a non-purchase licence can live there;
// `trial_<userId>` uses it as the idempotency key. Asking twice returns the same trial rather than extending it,
// which is the difference between a trial and a free product.
//
// WHAT IT DOES NOT DO: it grants nothing the paid tiers do not (it is `solo`, 1 seat, 14 days, no feed claim), so
// a corpus subscription is still a thing you buy. It is also not a subscription: when it expires it stops, and
// nothing renews it.
import { prisma } from '../db.js';
import { buildClaims, claimsFromRow, issuerKeyPemAsync, signLicence } from '../lib/licenceKey.js';

export const TRIAL_DAYS = 14;

/** The idempotency key: one trial per account, in the column that already means "this licence came from one checkout". */
export const trialKey = (userId) => `trial_${userId}`;
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


export default async function trialLicence({ user }) {
  if (!user?.id) throw Object.assign(new Error('sign in to start a trial'), { status: 401 });

  const existing = await prisma.licence.findUnique({ where: { stripe_session_id: trialKey(user.id) } });
  if (existing) {
    // Re-derived from the row, never stored as a token — the same rule every other licence follows.
    return {
      licence: await signWithDeploymentKey(prisma, claimsFromRow(existing)),
      plan: existing.plan,
      seats: existing.seats,
      state: 'already-issued',
      expiresAt: existing.expires_at,
    };
  }

  const claims = buildClaims({ accountId: user.id, plan: 'solo', seats: 1, days: TRIAL_DAYS });

  // Sign BEFORE writing: no issuer key means 503 and no row, so a trial that cannot be verified never looks issued.
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
        stripe_session_id: trialKey(user.id),
        note: `${TRIAL_DAYS}-day trial, issued once per account`,
      },
    });
  } catch (e) {
    // Two clicks at once: the unique index decides, and the loser returns the winner's trial rather than a 500.
    if (String(e?.code) === 'P2002') {
      const won = await prisma.licence.findUnique({ where: { stripe_session_id: trialKey(user.id) } });
      if (won) return { licence: await signWithDeploymentKey(prisma, claimsFromRow(won)), plan: won.plan, seats: won.seats, state: 'already-issued' };
    }
    throw e;
  }

  return {
    licence: token,
    plan: claims.plan,
    seats: claims.seats,
    state: 'issued',
    days: TRIAL_DAYS,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}
