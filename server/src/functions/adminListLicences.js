// adminListLicences.js — the operator's view of every licence, across every account.
//
// WHY IT EXISTS. `listLicences` is deliberately scoped to `created_by_id: user.id`; there was no way for an operator to
// see the licences a business runs on, or to find one because a customer emailed a jti. This is that view, and it is the
// one read in the product that is ALLOWED to cross accounts — so the rules are explicit and tested in licenceRegister.js
// rather than implicit in a query.
//
// WHAT IT DOES NOT DO. It does not return password hashes, OAuth ids or OTP codes: `rowView` is an allow-list (H16). It
// does not filter by the caller's own id (H2 — in an admin handler that would return nothing). And it has no write path:
// revoking is its own handler with its own audit entry.
import { prisma } from '../db.js';
import { assertAdmin, normaliseQuery, whereFor, searchFor, rowView } from '../lib/licenceRegister.js';

export default async function handler({ user, body }) {
  // The router already refuses a non-admin for a name in ADMIN_FUNCTIONS. This is the second lock, because a route table
  // is configuration and this file is the thing that runs.
  assertAdmin(user);

  const q = normaliseQuery(body);
  const where = { ...whereFor(q.state), ...searchFor(q.q) };

  const [rows, matching, all, revoked, expired] = await Promise.all([
    prisma.licence.findMany({
      where,
      orderBy: { issued_at: 'desc' },
      take: q.limit,
      skip: q.offset,
      // AN EXPLICIT SELECT, ALWAYS (H11): a column that exists in schema.prisma but not yet in production must not take
      // the whole screen down with P2022. This is also the disclosure rule — only these fields can reach a browser.
      select: {
        jti: true, plan: true, seats: true, kid: true,
        issued_at: true, expires_at: true, revoked_at: true, note: true,
        user: { select: { id: true, email: true, full_name: true } },
      },
    }),
    prisma.licence.count({ where }),
    prisma.licence.count(),
    prisma.licence.count({ where: { revoked_at: { not: null } } }),
    prisma.licence.count({ where: { revoked_at: null, expires_at: { lte: new Date() } } }),
  ]);

  return {
    licences: rows.map((r) => rowView(r)),
    page: { total: matching, limit: q.limit, offset: q.offset, q: q.q, state: q.state },
    // The whole estate, not the page: an operator's summary line must not change because they paged.
    estate: { all, revoked, expired, active: all - revoked - expired },
  };
}
