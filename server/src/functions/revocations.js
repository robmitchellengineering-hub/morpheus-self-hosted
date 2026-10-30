// revocations.js — the current revocation list, as a signed token the SDK verifies offline.
//
// PUBLIC: revocation lists are not secret, and an installer must be able to fetch one without an account. It is signed so a customer
// cannot be handed a list bearing their own id.
//
// FAILS CLOSED: with no signing key the endpoint refuses rather than publishing an unsigned list, because an unsigned list is a wish.
import { prisma } from '../db.js';
import { claimsForList } from '../lib/revocationList.js';
import { signLicence, issuerKeyStatus } from '../lib/licenceKey.js';

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
  let list;
  try {
    list = signLicence(claims);
  } catch (e) {
    // SAY WHICH FAULT IT IS. "No issuer key" for a key that is present but unparseable sends somebody to check a variable that is
    // already set — which is exactly what happened (Rob, 2026-11-02: "we have that api and the key").
    const st = issuerKeyStatus();
    const why = !st.configured
      ? 'no issuer key is configured (VVS_ISSUER_KEY_PEM or VALIANT_ISSUER_KEY)'
      : `${st.source} is set but cannot be used: ${st.why ?? 'the key could not be read'}`;
    return { ok: false, error: `no signed list can be produced — ${why}`, key: { configured: st.configured, source: st.source, parses: st.parses, fingerprint: st.fingerprint } };
  }
  const st = issuerKeyStatus();
  return {
    ok: true,
    list,
    signingKey: { source: st.source, fingerprint: st.fingerprint },
    count: claims.revocations.length,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}
