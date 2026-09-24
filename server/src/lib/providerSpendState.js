// The database half of real provider spend — recording readings, reading them back.
//
// Split from lib/providerSpend.js, which holds the arithmetic and imports nothing:
// a script in CI's `guards (no install)` job has to be able to test the rules that
// report real money, and it cannot reach Prisma.
//
// Both halves fail SOFT. Recording a reading happens inside the 15-minute balance
// poll, whose actual job is to warn before the balance hits zero — a bookkeeping
// insert must never be the reason that warning does not happen. Reading them back
// returns `available: false` with a reason rather than an empty number, because
// "we have not measured" and "we measured zero" are different answers and this
// whole module exists because they were being confused.
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { spendBetween } from './providerSpend.js';

/** Provider key used for DeepSeek's balance endpoint. */
export const DEEPSEEK = 'deepseek';

/**
 * Store one balance reading. Best-effort by design.
 *
 * Skips an unchanged balance rather than filling the table with a row every 15
 * minutes: the delta only needs the points where it moved, and a top-up or a
 * spend both show up as a change.
 */
export async function recordBalanceReading(provider, balanceUsd) {
  const value = Number(balanceUsd);
  if (!Number.isFinite(value)) return false;
  try {
    const last = await prisma.$queryRawUnsafe(
      'select balance_usd from provider_balance_readings where provider = $1 order by read_at desc limit 1',
      provider,
    );
    if (last.length && Number(last[0].balance_usd) === value) return false;
    await prisma.$executeRawUnsafe(
      'insert into provider_balance_readings (id, provider, balance_usd) values ($1, $2, $3)',
      crypto.randomUUID(), provider, value,
    );
    return true;
  } catch (err) {
    // Loud enough to find, quiet enough to be harmless: this runs inside the
    // balance safeguard, and losing a reading must not lose the safeguard.
    console.warn('[providerSpend] reading not recorded:', err?.message || err);
    return false;
  }
}

/** Every reading in the window, oldest first, reduced to what the rule needs. */
export async function spendOver(provider, hours = 24 * 30) {
  const windowHours = Math.min(Math.max(Number(hours) || 24 * 30, 1), 24 * 365);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `select balance_usd, read_at from provider_balance_readings
        where provider = $1 and read_at > now() - ($2 || ' hours')::interval
        order by read_at asc`,
      provider, String(windowHours),
    );
    const measured = spendBetween(rows.map((r) => ({ balanceUsd: r.balance_usd, readAt: r.read_at })));
    return { ...measured, windowHours };
  } catch (err) {
    const missing = err?.code === 'P2021' || /relation\s+"?provider_balance_readings"?\s+does not exist/i.test(err?.message || '');
    return {
      available: false,
      windowHours,
      reason: missing
        ? 'the provider_balance_readings table does not exist on this deployment'
        : String(err?.message || err),
    };
  }
}
