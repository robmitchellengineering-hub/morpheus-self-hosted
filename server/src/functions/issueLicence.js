// Issue a licence to the signed-in account — the join between the signature and the row.
//
// Rob's design: Morpheus issues the licence UNDER THE BUYER'S OWN ACCOUNT, so he can see and revoke them
// on a private page. Two halves already exist and are proven: `licenceKey.js` (claims + signature, 13
// cases) and the `licences` table (live in production, PR #701). This function is what connects them to a
// person, and it is deliberately dull: who you are comes from the session, never from the body.
//
// WHAT IS NEVER STORED: the token. It is DERIVED from the row's own fields, so a dump of the table yields
// nothing a shipped build will accept without the private key that never leaves the deployment.
//
// WHAT A CALLER CANNOT DO: pick an account (it is `user.id`), mint for another plan without paying the
// path that reaches this function, choose the signing key (it is the deployment's), or read anyone
// else's licences (the list route is scoped the same way).
import { prisma } from '../db.js';
import { buildClaims, signLicence, PLANS } from '../lib/licenceKey.js';

export default async function handler({ user, body }) {
  if (!user?.id) {
    throw Object.assign(new Error('Sign in to issue a licence.'), { status: 401 });
  }

  // ADMIN ONLY, and this was wrong for one commit rather than for long: the function shipped taking its
  // account from the session — which is right — but nothing stopped ANY signed-in account from being the
  // one it issued to. Free registration plus a 365-day `team` default is a paid product given away, and
  // the only thing standing between the two was that nobody had looked.
  //
  // The plan/seat path that actually sells licences (payment -> issue) is not wired yet, so this is
  // deliberately the narrow door: an admin issues for an account. When payment exists, the webhook calls
  // this same function with the same claims; the check below becomes "admin OR verified payment reference"
  // and that is one condition to widen, not a rewrite.
  if (user.role !== 'admin') {
    throw Object.assign(
      new Error('Only an admin can issue a licence. Licences are issued to your own account when a plan is bought.'),
      { status: 403 },
    );
  }

  const plan = body?.plan ?? 'solo';
  const days = body?.days ?? 365;
  const seats = body?.seats;

  // buildClaims owns validation — unknown plan, missing account, non-positive days all throw 400 there,
  // so there is one place that decides what a legal claim is rather than a second opinion here.
  const claims = buildClaims({ accountId: user.id, plan, days, seats });

  // Sign BEFORE writing. If the deployment has no key, this throws 503 and no row is created: a licence
  // that exists but cannot be verified is worse than no licence, because it looks issued.
  const token = signLicence(claims);

  const row = await prisma.licence.create({
    data: {
      created_by_id: user.id,
      jti: claims.jti,
      plan: claims.plan,
      seats: claims.seats,
      kid: claims.kid,
      issued_at: new Date(claims.iat * 1000),
      expires_at: new Date(claims.exp * 1000),
      note: typeof body?.note === 'string' ? body.note.slice(0, 500) : null,
    },
  });

  return {
    // The token is returned ONCE, on creation. It is not readable again from the table.
    licence: token,
    jti: row.jti,
    plan: row.plan,
    seats: row.seats,
    expiresAt: row.expires_at,
    // Says where the credential now lives, so the caller does not have to guess.
    install: 'valiant licence --file <this licence saved to a file>',
    plans: Object.keys(PLANS),
  };
}
