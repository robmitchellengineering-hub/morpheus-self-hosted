// getUsage — read-only: what is this account's balance, and what has it spent lately.
//
// WHY IT EXISTS. Ask Alice can prove an AI call ran and metered (the runAiAction response carries the usage
// block), but a device token could not read the balance, so the one question a buyer asks — "what have I got
// left, and what did that cost" — had no answer from the tool. `askalice status` printed "not readable with this
// token yet" rather than an estimate, which is the honest state this function replaces.
//
// DELIBERATELY NARROW. It reads three things for the CALLING user and nothing else: no user id in the body, no
// admin scope, no writes. A read-only surface that takes an id is an enumeration bug waiting to happen, so the
// only identity it will accept is the one the token already proves.
//
// It is added to DEVICE_SCOPE_FUNCTIONS.ai_action next to runAiAction (server/src/lib/deviceToken.js), so a
// `dvc_` token for the scoped AI action can read its own account's balance — nothing wider.
import { prisma } from '../db.js';

const RECENT = 5;

export default async function handler({ user }) {
  const userId = user?.id;
  if (!userId) throw Object.assign(new Error('not signed in'), { status: 401 });

  const me = await prisma.user.findUnique({
    where: { id: userId },
    // Only fields that exist on User: `plan` is on Licence, not here — selecting it would throw at runtime.
    select: { credit_balance: true, email: true }
  });
  if (!me) throw Object.assign(new Error('no such account'), { status: 401 });

  // Two different histories, both useful and neither a substitute for the other:
  //   UsageRecord      — what the account spent credits ON (bucketed, older ledger)
  //   CreditTransaction— what the account BOUGHT
  // A failure in either must not hide the balance, which is the number being asked for.
  let recentUsage = [];
  let recentPurchases = [];
  try {
    recentUsage = await prisma.usageRecord.findMany({
      where: { created_by_id: userId },
      orderBy: { created_date: 'desc' },
      take: RECENT,
      select: { action_type: true, credits: true, project_name: true, created_date: true }
    });
  } catch { /* an unreadable ledger is not an unreadable balance */ }
  try {
    recentPurchases = await prisma.creditTransaction.findMany({
      where: { created_by_id: userId },
      orderBy: { created_date: 'desc' },
      take: RECENT,
      select: { credits: true, amount_usd: true, status: true, created_date: true }
    });
  } catch { /* same */ }

  return {
    email: me.email ?? null,
    credit_balance: Number(me.credit_balance ?? 0),
    recent_usage: recentUsage.map((r) => ({
      action: r.action_type,
      credits: r.credits,
      project: r.project_name ?? null,
      at: r.created_date
    })),
    recent_purchases: recentPurchases.map((r) => ({
      credits: Number(r.credits ?? 0),
      amount_usd: r.amount_usd ?? 0,
      status: r.status,
      at: r.created_date
    }))
  };
}
