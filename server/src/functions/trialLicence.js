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

/**
 * THE FIRST TEN GET TWELVE MONTHS, which is what the pricing page has promised since it was written ("First 10 — 12 months
 * free, for a named reference"). Until now the only licence a partner could self-serve was 14 days, so the promise and the
 * product disagreed and the partner would have discovered it a fortnight in.
 *
 * A count of existing trials is the whole rule — no flag to set, no admin action, no way to issue to somebody else's account
 * (`issueLicence` can only ever issue to its caller, which is why this belongs here rather than in a button). The eleventh
 * account gets the standard trial, and the reply says which one it got.
 */
export const PARTNER_LICENCES = 10;
export const PARTNER_DAYS = 365;

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

  // How many people have started a trial before this one? The first ten are design partners.
  let partnerNumber = null;
  try {
    const prior = await prisma.licence.count({ where: { stripe_session_id: { startsWith: 'trial_' } } });
    if (prior < PARTNER_LICENCES) partnerNumber = prior + 1;
  } catch {
    // A count that cannot be read must not silently upgrade somebody to a year. It falls through to the standard trial, and
    // the reply carries `days`, so the outcome is visible rather than assumed.
  }

  const days = partnerNumber ? PARTNER_DAYS : TRIAL_DAYS;
  const plan = partnerNumber ? 'team' : 'solo';
  const seats = partnerNumber ? 5 : 1;
  const claims = buildClaims({ accountId: user.id, plan, seats, days });

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
        note: partnerNumber
          ? `design partner #${partnerNumber}: ${PARTNER_DAYS} days, ${seats} seats, for a named reference`
          : `${TRIAL_DAYS}-day trial, issued once per account`,
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
    // WHICH ONE YOU GOT IS IN THE REPLY, because the page must be able to say "you are design partner #3, twelve months"
    // rather than showing a 14-day number to somebody the site promised a year to.
    days,
    partner: partnerNumber,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    note: partnerNumber
      ? `design partner #${partnerNumber} of ${PARTNER_LICENCES} — ${PARTNER_DAYS} days, ${seats} seats`
      : `${TRIAL_DAYS}-day trial`,
  };
}
