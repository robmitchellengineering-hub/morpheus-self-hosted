// Per-build spend ceiling — the context and the rule, with no database.
//
// THE PROBLEM IT CLOSES (docs/CREDITS-POLICY.md §8): `reserveCredits` bounds one
// AI call; nothing bounded a BUILD. An autonomous loop can call the model dozens
// of times unattended, and the account's whole balance is its only limit.
//
// HOW THE PROJECT REACHES THE RESERVATION. `invokeAI()` is called from many
// places, most of which have no project in scope. Threading a `projectId` through
// every call site would touch the build loop far more than the ceiling needs, so
// the two build entry points put the project in an AsyncLocalStorage context and
// `reserveCredits` reads it. That is context, not build semantics: planning,
// coding, reviewing and file application are untouched.
//
// The BUDGET itself is stored by `buildBudgetStore.js` (which imports Prisma) in
// `PlatformSetting`, keyed by project id. This file stays import-free apart from
// node builtins so the guard can test the rule in CI's no-install job.

import { AsyncLocalStorage } from 'node:async_hooks';
import { withinBuildCeiling } from './creditPolicy.js';

export const BUILD_BUDGET_PREFIX = 'build_budget_';
export const BUILD_CONSENT_PREFIX = 'build_ceiling_consent_';

const storage = new AsyncLocalStorage();

/**
 * The PlatformSetting key holding the credits already reserved by one project's
 * build. The value is a plain decimal string so the increment can be a single
 * atomic SQL statement; `updated_date` is the build's liveness clock.
 */
export function buildBudgetKey(projectId) {
  return `${BUILD_BUDGET_PREFIX}${String(projectId || '')}`;
}

/** The PlatformSetting key holding the explicit per-project consent, in credits. */
export function buildConsentKey(projectId) {
  return `${BUILD_CONSENT_PREFIX}${String(projectId || '')}`;
}

/**
 * Put `projectId` into the current async context. Call this from a build entry
 * point only, immediately after the project has been resolved and authorised.
 * A missing/blank id clears the context rather than inheriting the previous one.
 */
export function enterBuild(projectId) {
  storage.enterWith({ projectId: projectId ? String(projectId) : null, enteredAt: new Date() });
}

/** Leave the build context (used when a handler finishes). */
export function exitBuild() {
  storage.enterWith({ projectId: null, enteredAt: null });
}

/** The current context, or null outside a build. */
export function currentBuild() {
  return storage.getStore() || null;
}

/** The project id of the build this async call belongs to, or null. */
export function currentBuildProjectId() {
  return currentBuild()?.projectId || null;
}

/** The one rule the reservation path calls. Re-exported so callers import one name. */
export function buildCeilingAllows(spentCredits, requestedCredits, ceilingCredits, consentCredits = 0) {
  return withinBuildCeiling(spentCredits, requestedCredits, ceilingCredits, consentCredits);
}

/**
 * A reservation amount, or `null` when it cannot be read.
 *
 * This exists so the storage half cannot fail OPEN. `withinBuildCeiling` already
 * refuses a NaN, but a store that checked `Number.isFinite(requested)` and
 * `return null`-ed before calling it would let an unreadable amount bypass the
 * ceiling entirely — a guard passing on the pure rule while the wiring skipped
 * it (H19). A negative amount is refused for the same reason.
 */
export function buildReservationAmount(value) {
  // Absent is not zero: a call site that forgot to pass its estimate must be
  // refused by the store rather than counted as a free step.
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A stored spend value, or `null` when it cannot be read.
 *
 * The same fail-closed rule for the OTHER direction: a corrupted
 * `platform_settings.value` must not be read as zero spend, because that
 * forgets what the build has already used and lets it overspend. `null` makes
 * the store refuse the step and name the row to clear, rather than silently
 * starting the budget again.
 */
export function parseBuildSpend(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Read an explicit per-project consent amount, in credits.
 *
 * `0` is a real answer — revoke the consent — so it cannot share the `null`
 * that means "unreadable". A negative, blank or non-numeric value is refused
 * rather than coerced to zero: a consent write that silently grants nothing
 * would look like it worked and leave an unattended build blocked.
 *
 * Lives here, with the key helpers, so the admin route and the guard reach the
 * same rule instead of keeping two spellings of "a positive number".
 */
export function buildConsentAmount(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10000) / 10000;
}
