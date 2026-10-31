// revocations.js — the current revocation list, as a signed token the SDK verifies offline.
//
// PUBLIC: revocation lists are not secret, and an installer must be able to fetch one without an account. It is signed so a customer
// cannot be handed a list bearing their own id.
//
// FAILS CLOSED: with no signing key the endpoint refuses rather than publishing an unsigned list, because an unsigned list is a wish.
import { prisma } from '../db.js';
import { claimsForList } from '../lib/revocationList.js';
import { signLicence, issuerKeyPemAsync } from '../lib/licenceKey.js';

export default async function revocations() {
  let jtis;
  try {
    const rows = await prisma.$queryRaw`
      select jti from licences where revoked_at is not null order by revoked_at desc limit 1000`;
    jtis = (rows ?? []).map((r) => r.jti).filter(Boolean);
  } catch (e) {
    // A database that cannot answer must not be reported as "nothing is revoked".
    return { ok: false, error: 'the revocation list could not be read' };
  }

  const claims = claimsForList(jtis);
  // The environment wins; the database is the fallback. Refusing "no issuer key" while one is stored would be the deployment lying.
  const key = await issuerKeyPemAsync(prisma);
  let list;
  try {
    list = signLicence(claims, key.pem ?? undefined);
  } catch {
    return { ok: false, error: 'this deployment has no issuer key, so no signed list can be produced' };
  }
  return {
    ok: true,
    list,
    count: claims.revocations.length,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}
