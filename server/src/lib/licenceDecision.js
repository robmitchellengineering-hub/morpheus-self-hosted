// licenceDecision.js — everything the public check decides, with no database import.
//
// WHY THIS MOVED. The endpoint used to hold this logic, so testing "a database that will not answer must not be reported as valid" meant
// either importing prisma into a guard (which the no-install job cannot do) or grepping the endpoint's source for the right words. Neither
// proves behaviour. The logic lives here, `db` is injected, and `licenceCheck.js` is a one-line wrapper that supplies prisma.
import { normalizeCheckBody, checkReply } from './licenceCheckShape.js';
import { verifyToken } from './licenceVerify.js';

/**
 * The one fact a token cannot carry: whether it has been withdrawn since it was signed. Throws when the database cannot answer, so the
 * caller must decide what "cannot check" means — it must never be "fine".
 */
export async function lookupRevocation(jti, db) {
  if (!db) throw new Error('no database to read the revocation list from');
  const rows = await db.$queryRaw`
      select revoked_at from licences where jti = ${String(jti ?? '')} limit 1`;
  return !!(rows?.[0]?.revoked_at);
}

/**
 * The whole answer. Fails closed at every step: a body that is not a licence, a signature that does not verify, and a database that does
 * not reply all produce `valid: false` with a reason a human can act on.
 */
// SECONDS, NOT MILLISECONDS. verifyToken compares against epoch seconds; passing Date.now() made every licence read as "expired 20736518
// days ago" — and only a test that actually called this with a real token could see it. Default computed in the right unit.
export async function decideCheck({ body, db, now = Math.floor(Date.now() / 1000) } = {}) {
  const shape = normalizeCheckBody(body);
  if (!shape.ok) return checkReply({ valid: false, why: shape.why });

  const v = verifyToken(shape.token, now);
  if (!v.ok) return checkReply({ valid: false, claims: v.claims ?? null, why: v.why });

  let revoked = false;
  try {
    revoked = await lookupRevocation(v.claims.jti, db);
  } catch {
    // A database that cannot answer must not be reported as "not revoked". The SDK treats an errored check as "cannot check", which is red.
    return checkReply({ valid: false, claims: v.claims, why: 'the revocation list could not be read — try again shortly' });
  }

  if (revoked) return checkReply({ valid: false, claims: v.claims, revoked: true, why: 'this licence has been revoked' });
  return checkReply({ valid: true, claims: v.claims });
}
