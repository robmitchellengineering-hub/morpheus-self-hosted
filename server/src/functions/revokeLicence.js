// Revoke one of the caller's own licences.
//
// The update is scoped in the WHERE clause, not checked afterwards: `created_by_id: user.id` means a
// caller cannot revoke a row they do not own even by guessing a jti, and a jti that is not theirs simply
// updates nothing. Idempotent — revoking an already-revoked licence keeps the first timestamp, because
// the second one is not a second event.
import { prisma } from '../db.js';

export default async function handler({ user, body }) {
  if (!user?.id) {
    throw Object.assign(new Error('Sign in to revoke a licence.'), { status: 401 });
  }
  const jti = typeof body?.jti === 'string' ? body.jti.trim() : '';
  if (!jti) throw Object.assign(new Error('jti required — which licence to revoke'), { status: 400 });

  const existing = await prisma.licence.findFirst({ where: { jti, created_by_id: user.id } });
  if (!existing) throw Object.assign(new Error('No such licence on this account.'), { status: 404 });
  if (existing.revoked_at) return { jti, revokedAt: existing.revoked_at, alreadyRevoked: true };

  const row = await prisma.licence.update({
    where: { jti },
    data: { revoked_at: new Date() },
    select: { jti: true, revoked_at: true },
  });
  return { jti: row.jti, revokedAt: row.revoked_at, alreadyRevoked: false };
}
