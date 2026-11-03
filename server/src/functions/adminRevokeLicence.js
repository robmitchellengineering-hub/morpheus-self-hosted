// adminRevokeLicence.js — switch off any account's licence, deliberately, with a record.
//
// WHY IT EXISTS. `revokeLicence` is scoped in its WHERE clause to the caller's own rows, which is the right shape for a
// customer and the wrong one for an operator: a refund, a stolen laptop, an abusive account or a machine that must be
// silenced had no route through the product. This is that route.
//
// WHAT MAKES IT SAFE RATHER THAN DANGEROUS. It is admin-only twice over (route table + assertAdmin), it is idempotent
// (revoking twice keeps the first timestamp, because the second is not a second event), it refuses rather than creating a
// row that does not exist, and every revoke that changes something writes an audit entry naming the admin, the jti and
// the account. The audit write cannot fail the revoke: losing a licence record is worse than losing one audit line, and
// the failure is logged instead of swallowed.
import { prisma } from '../db.js';
import { assertAdmin } from '../lib/licenceRegister.js';

export default async function handler({ user, body }) {
  assertAdmin(user);

  const jti = typeof body?.jti === 'string' ? body.jti.trim() : '';
  if (!jti) throw Object.assign(new Error('jti required — which licence to revoke'), { status: 400 });

  const existing = await prisma.licence.findUnique({
    where: { jti },
    select: { jti: true, plan: true, created_by_id: true, revoked_at: true },
  });
  if (!existing) throw Object.assign(new Error('No such licence.'), { status: 404 });
  if (existing.revoked_at) return { jti, revokedAt: existing.revoked_at, alreadyRevoked: true };

  const row = await prisma.licence.update({
    where: { jti },
    data: { revoked_at: new Date() },
    select: { jti: true, revoked_at: true },
  });

  // An audit entry per changed revoke. Best-effort by design, and a failure is reported to the server log rather than
  // turning a completed revocation into an error the operator would retry (which would be a no-op and read as broken).
  try {
    await prisma.adminAuditLog.create({
      data: {
        admin_id: user.id,
        action: 'licence.revoke',
        details: JSON.stringify({ jti, plan: existing.plan, accountId: existing.created_by_id }),
      },
    });
  } catch (e) {
    console.error(`adminRevokeLicence: revoked ${jti} but the audit entry failed: ${e?.message ?? e}`);
  }

  return { jti: row.jti, revokedAt: row.revoked_at, alreadyRevoked: false };
}
