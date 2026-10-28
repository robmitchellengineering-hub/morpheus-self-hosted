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
