// licenceCheck.js — the online licence check the SDK asks (Rob, 2026-11-02: "licence verification needs to be done online").
//
// It answers three questions and nothing else: is this token genuinely ours, is it still in date, and has it been revoked. The
// public key is committed, so a token accepted here is one the SDK would also accept; the database supplies the revocation, which
// is the fact a token cannot carry.
//
// PUBLIC like the other six, because an SDK on a customer's laptop has no account here. That makes it safe to be boring: bounded
// input, no echo of the token, no detail beyond a reason string.
import { prisma } from '../db.js';
import { normalizeCheckBody, checkReply } from '../lib/licenceCheckShape.js';
import { verifyToken } from '../lib/licenceVerify.js';

export default async function licenceCheck({ body }) {
  const shape = normalizeCheckBody(body);
  if (!shape.ok) return checkReply({ valid: false, why: shape.why });

  const v = verifyToken(shape.token);
  if (!v.ok) return checkReply({ valid: false, claims: v.claims ?? null, why: v.why });

  // THE REVOCATION IS THE ONE FACT A TOKEN CANNOT CARRY, which is why this endpoint exists at all: a licence that verified
  // offline this morning can have been withdrawn since.
  let revoked = false;
  try {
    const rows = await prisma.$queryRaw`
      select revoked_at from licences where jti = ${String(v.claims.jti ?? '')} limit 1`;
    revoked = !!(rows?.[0]?.revoked_at);
  } catch {
    // A database that cannot answer must not be reported as "not revoked" — that is the fail-open shape this product exists to
    // catch. The SDK treats an errored check as "cannot check", which is red.
    return checkReply({ valid: false, claims: v.claims, why: 'the revocation list could not be read — try again shortly' });
  }

  if (revoked) return checkReply({ valid: false, claims: v.claims, revoked: true, why: 'this licence has been revoked' });
  return checkReply({ valid: true, claims: v.claims });
}
