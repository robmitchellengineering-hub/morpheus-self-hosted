// The storage half of the per-build spend ceiling.
//
// `buildBudget.js` holds the context and the rule (import-free, so a guard can
// test it). This file owns the database: the budget is a `PlatformSetting` row,
// keyed by project id, so the ceiling is per project and survives a restart or a
// second server instance — an in-memory counter would reset on every
// `autonomousBuildStep` request, which is exactly the loop the ceiling exists to
// bound.
//
// WHY PlatformSetting AND NOT A NEW TABLE. The repository's migration workflow is
// hand-run SQL with no migrations directory (hazard H8/H11), and this is billing
// machinery shipping behind commercial placeholders that are all off. Storing an
// operational counter in the existing key/value store avoids a production schema
// change for a mechanism Rob has not switched on yet. `finishBuild` removes the
// row so the table does not accumulate dead projects.
//
// THE CHECK AND THE INCREMENT ARE ONE STATEMENT. A read-then-write would let two
// concurrent lane calls both pass the check and then lose one increment, which is
// a ceiling that overshoots exactly when a build is busiest. `reserveBuildCredits`
// locks the row, checks, and increments in one transaction; if the balance update
// afterwards cannot proceed, `releaseBuildCredits` puts the reservation back.

import { prisma } from '../db.js';
import { buildCeilingCredits } from './creditPolicy.js';
import {
  buildBudgetKey,
  buildConsentKey,
  buildCeilingAllows,
} from './buildBudget.js';

// A budget older than this is a different build. `autonomousBuildStep` is one
// request per step and has no run id to tell two runs apart, so without a clock a
// run abandoned by a browser tab left open would hold its spend against every
// later run on the project forever. This is operational, not commercial: it is
// not a credit amount and does not need Rob to set it.
const BUILD_BUDGET_STALE_MS = 12 * 60 * 60 * 1000;

/** A build reservation that would cross the project's ceiling. HTTP 402, like running out. */
export class BuildCeilingExceededError extends Error {
  constructor({ projectId, spentCredits, requestedCredits, ceilingCredits, consentCredits }) {
    const allowed = Number(ceilingCredits) + Number(consentCredits || 0);
    super(
      `This build has used ${Number(spentCredits).toFixed(2)} of its `
      + `${allowed.toFixed(2)}-credit ceiling (this step needs ~${Number(requestedCredits).toFixed(2)}). `
      + 'A human must grant more build credits for this project before it can continue.',
    );
    this.name = 'BuildCeilingExceededError';
    this.status = 402;
    this.code = 'BUILD_CEILING_EXCEEDED';
    this.projectId = projectId;
    this.spentCredits = spentCredits;
    this.requestedCredits = requestedCredits;
    this.ceilingCredits = ceilingCredits;
    this.consentCredits = consentCredits;
    this.needed = requestedCredits;
  }
}

/** The stored value is a decimal string; anything unreadable is "no spend", never NaN. */
function parseSpent(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isStale(updatedDate) {
  const at = updatedDate instanceof Date ? updatedDate.getTime() : new Date(updatedDate || 0).getTime();
  return !Number.isFinite(at) || Date.now() - at > BUILD_BUDGET_STALE_MS;
}

async function readConsent(tx, projectId) {
  try {
    const row = await tx.platformSetting.findUnique({
      where: { key: buildConsentKey(projectId) },
      select: { value: true },
    });
    const n = Number(row?.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Start a NEW build budget for a project (a chat build turn). */
export async function beginBuild(projectId) {
  if (!projectId || buildCeilingCredits() == null) return null;
  try {
    return await prisma.platformSetting.upsert({
      where: { key: buildBudgetKey(projectId) },
      update: { value: '0' },
      create: { key: buildBudgetKey(projectId), value: '0' },
    });
  } catch {
    // The ceiling must never break a build because its bookkeeping failed.
    return null;
  }
}

/**
 * Continue the project's current budget (an autonomous step), creating one only
 * if none exists. A multi-request autonomous loop must not reset its spend; a
 * budget older than the stale window is a new run and does reset.
 */
export async function continueBuild(projectId) {
  if (!projectId || buildCeilingCredits() == null) return null;
  try {
    const existing = await prisma.platformSetting.findUnique({
      where: { key: buildBudgetKey(projectId) },
      select: { key: true, value: true, updated_date: true },
    });
    if (existing && !isStale(existing.updated_date)) return existing;
    return await prisma.platformSetting.upsert({
      where: { key: buildBudgetKey(projectId) },
      update: { value: '0' },
      create: { key: buildBudgetKey(projectId), value: '0' },
    });
  } catch {
    return null;
  }
}

/** The build is complete (or abandoned): the next one starts from zero. */
export async function finishBuild(projectId) {
  if (!projectId) return;
  try {
    await prisma.platformSetting.deleteMany({ where: { key: buildBudgetKey(projectId) } });
  } catch {
    // Same rule as above: bookkeeping failure is not a build failure.
  }
}

/**
 * Check the ceiling and count the reservation, atomically.
 *
 * Returns the state it judged (spent before, spent after, ceiling, consent) or
 * null when the ceiling is off. Throws BuildCeilingExceededError (402) when the
 * step would cross it, before any balance is touched and before any AI call.
 */
export async function reserveBuildCredits(projectId, requestedCredits) {
  const ceiling = buildCeilingCredits();
  if (ceiling == null || !projectId) return null;

  const requested = Number(requestedCredits || 0);
  if (!Number.isFinite(requested) || requested < 0) return null;

  const key = buildBudgetKey(projectId);
  return prisma.$transaction(async (tx) => {
    // Create the row without overwriting an existing one. On a concurrent first
    // call the loser blocks here, then the SELECT FOR UPDATE sees the winner's row.
    await tx.$executeRaw`
      INSERT INTO platform_settings (key, value, updated_date)
      VALUES (${key}, '0', NOW())
      ON CONFLICT (key) DO NOTHING
    `;
    const rows = await tx.$queryRaw`
      SELECT value, updated_date FROM platform_settings WHERE key = ${key} FOR UPDATE
    `;
    const row = rows[0] || null;
    const spent = row && !isStale(row.updated_date) ? parseSpent(row.value) : 0;
    const consent = await readConsent(tx, projectId);

    if (!buildCeilingAllows(spent, requested, ceiling, consent)) {
      throw new BuildCeilingExceededError({
        projectId,
        spentCredits: spent,
        requestedCredits: requested,
        ceilingCredits: ceiling,
        consentCredits: consent,
      });
    }

    const next = Math.round((spent + requested) * 10000) / 10000;
    if (next !== spent) {
      await tx.$executeRaw`
        UPDATE platform_settings SET value = ${String(next)}, updated_date = NOW()
        WHERE key = ${key}
      `;
    } else {
      // A zero-credit reservation still refreshes the liveness clock.
      await tx.$executeRaw`
        UPDATE platform_settings SET updated_date = NOW() WHERE key = ${key}
      `;
    }

    return { spentCredits: spent, nextSpentCredits: next, ceilingCredits: ceiling, consentCredits: consent };
  });
}

/**
 * Put back a reservation whose balance update could not proceed. Best effort:
 * the direction of error is deliberately conservative (a budget that over-counts
 * blocks early; one that under-counts overspends).
 */
export async function releaseBuildCredits(projectId, credits) {
  const ceiling = buildCeilingCredits();
  if (ceiling == null || !projectId) return;
  const amount = Number(credits || 0);
  if (!Number.isFinite(amount) || amount <= 0) return;
  try {
    await prisma.$executeRaw`
      UPDATE platform_settings
      SET value = GREATEST(COALESCE(NULLIF(value, ''), '0')::numeric - ${amount}::numeric, 0)::text,
          updated_date = NOW()
      WHERE key = ${buildBudgetKey(projectId)}
    `;
  } catch {
    // Bookkeeping must never fail the reservation that already returned.
  }
}
