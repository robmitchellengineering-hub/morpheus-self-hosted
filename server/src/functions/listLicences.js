// The caller's own licences — the read half of the private management page.
//
// Scoped by `user.id` and nothing else: there is no projectId, no account parameter, no way to ask for
// someone else's rows. Revoked licences are LISTED, not hidden, because a page that silently drops them
// makes a revocation look like a deletion and hides the audit trail.
import { prisma } from '../db.js';

export default async function handler({ user }) {
  if (!user?.id) {
    throw Object.assign(new Error('Sign in to see your licences.'), { status: 401 });
  }
  const rows = await prisma.licence.findMany({
    where: { created_by_id: user.id },
    orderBy: { created_date: 'desc' },
    select: { jti: true, plan: true, seats: true, kid: true, issued_at: true, expires_at: true, revoked_at: true, note: true },
  });
  const now = Date.now();
  return {
    licences: rows.map((r) => ({
      ...r,
      // Derived state, so the page never has to decide what "active" means and get it wrong.
      state: r.revoked_at ? 'revoked' : (r.expires_at.getTime() < now ? 'expired' : 'active'),
    })),
  };
}
