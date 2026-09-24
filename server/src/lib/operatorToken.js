// Operator token — a scoped, revocable credential that lets a non-browser
// client drive self-dev. Used by scripts/morpheus.mjs.
//
// WHY THIS EXISTS
//
// Self-dev's entire post-push chain lives in the browser (SelfDev.jsx:186-281):
// the checks are polled, the PR is merged, synced_commit is written, the deploy
// is watched and the smoke check is run by effects inside a React component.
// Its admin functions are reachable only with an admin JWT. So nothing outside
// a logged-in tab can run the pipeline, and nothing outside it can *observe* a
// run either — which is why a 3-in-17 revert rate and three capabilities that
// have never executed went unnoticed for a week.
//
// This is the smallest thing that changes that: a bearer token that can do what
// the /self-dev page does, and nothing else.
//
// WHERE IT SITS
//
// It is the third instance of a shape this repo already has twice
// (lib/widgetToken.js, lib/deviceToken.js): a prefixed token, resolvable
// server-side to a user, with its own explicit scope map. The differences are
// deliberate, not incidental:
//
//   * A WIDGET token acts as a site owner and is boxed into one project. A
//     DEVICE token acts as the end user but is limited to runAiAction. An
//     OPERATOR token acts as the self-dev workspace's owner and may touch ONLY
//     that workspace — every function it can reach is scoped to the singleton
//     self_dev project, so it cannot read or edit any customer's project.
//   * It is stored as a SHA-256 hash in an environment variable rather than a
//     row, because it must not depend on a migration. KNOWN-HAZARDS H11 is
//     that you cannot assume a migration has been applied when the code
//     deploys — and this deployment has never run one at all: the
//     self_dev_migrations table does not exist in production, because
//     applySelfDevMigrations has never been called. A credential that needs a
//     new table would be a credential that might silently not work. Rotation
//     is unsetting one variable.
//   * It has NO escape hatches. The allow-list below is the whole of its
//     power, and the four documented ways to get around a gate — `force`,
//     `directToMain`, `acknowledgeDrift` and `scopePolicy` — are stripped from
//     its request body before dispatch (see stripOperatorEscapeHatches). The
//     credential physically cannot push to main, cannot skip the verify gate,
//     cannot override the H9 drift guard, and cannot have a scoped push exempt
//     it from that guard. Those stay human-only, in the UI, behind a click.
//
// Pure by design: no imports beyond crypto, no database, no environment reads
// except the injected one. That keeps the rules testable in the cheap tier —
// the same reason lib/requiredChecks.js and lib/selfDevDrift.js's evaluator are
// pure — and it is what scripts/verify-operator-drive.mjs exercises.
import crypto from 'node:crypto';

/** Token prefix. A value starting with this is treated as an operator token. */
export const OPERATOR_TOKEN_PREFIX = 'opr_';

/** Where the expected SHA-256 (hex, lowercase) of the token is configured. */
export const OPERATOR_TOKEN_ENV = 'MORPHEUS_OPERATOR_TOKEN_SHA256';

/**
 * The complete set of functions the operator token may call.
 *
 * Deliberately absent, and each for its own reason:
 *   revertSelfDevPush      — rewrites production history. A human decides that.
 *   applySelfDevMigrations — executes DDL. Not from a script.
 *   buildDeckWidget        — elevates to a privileged actor and can ship
 *                            scoped changes to another surface.
 *   generateSelfDevManual  — writes a document; no dogfood value.
 *   generateSelfDevPrototype, synthesizeUpdatesPlan, generateRebuildDoc — heavy
 *                            read-only admin docs, no dogfood value.
 *   everything else        — not self-dev.
 */
export const OPERATOR_SCOPE_FUNCTIONS = [
  // The pipeline, in the order a dogfood run uses it.
  'importSelfDevRepo',
  'chatWithMorpheus',
  'verifySelfDev',
  'pushSelfDevToGithub',
  'mergeSelfDevPr',
  'smokeCheckSelfDev',
  // Read-only state, so a run can be inspected without a database client.
  'getSelfDevFeatures',
  'getSelfDevDecisions',
];

const OPERATOR_SCOPE_SET = new Set(OPERATOR_SCOPE_FUNCTIONS);

/**
 * The body fields that would let a caller step around a gate. Stripped, never
 * honoured, for operator calls. See the header: these are the whole reason the
 * credential is safe to hand to a non-human client.
 */
export const OPERATOR_FORBIDDEN_FIELDS = ['force', 'directToMain', 'acknowledgeDrift', 'scopePolicy'];

/**
 * Ceiling on self-dev chat turns an operator token may start per UTC day.
 *
 * A chat turn spends real platform AI credits (the self-dev workspace owner is
 * an admin, so billing is exempt — exempt means "don't charge", not "don't
 * cost"; see lib/billing.js). Without a ceiling, a client that retries in a
 * loop is an unbounded spend with no human in it. Mirrors the velocity cap
 * tenantPolicy.js applies to WordPress tenants.
 */
export const OPERATOR_DAILY_TURN_CAP = 40;

/** Is a hash configured on this deployment at all? */
export function operatorTokenConfigured(env = process.env) {
  const hash = env?.[OPERATOR_TOKEN_ENV];
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash.trim().toLowerCase());
}

/** Cheap shape test, so the route can tell an operator token from a JWT. */
export function isOperatorToken(value) {
  return typeof value === 'string'
    && value.startsWith(OPERATOR_TOKEN_PREFIX)
    && value.length > OPERATOR_TOKEN_PREFIX.length + 16;
}

/** SHA-256 of a token value, hex. The hash is what is stored; never the token. */
export function hashOperatorToken(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/**
 * Constant-time comparison against the configured hash.
 *
 * Both sides go through SHA-256 first, so the buffers are always 32 bytes and
 * timingSafeEqual cannot throw on a length mismatch — and the comparison leaks
 * nothing about how much of a wrong guess was right. Never logs, never returns
 * the token, never returns the hash.
 */
export function verifyOperatorToken(value, env = process.env) {
  if (!operatorTokenConfigured(env)) return false;
  if (typeof value !== 'string' || value.length === 0) return false;
  const expected = Buffer.from(env[OPERATOR_TOKEN_ENV].trim().toLowerCase(), 'hex');
  const actual = crypto.createHash('sha256').update(value, 'utf8').digest();
  return crypto.timingSafeEqual(expected, actual);
}

/** May this function be called with an operator token? */
export function operatorMayCall(name) {
  return OPERATOR_SCOPE_SET.has(String(name ?? ''));
}

/**
 * Remove every escape hatch from an operator request body.
 *
 * Returns a NEW body (the caller's object is not mutated) plus the list of
 * fields that were actually present, so the route can put them in the audit
 * row. A stripped field is dropped, not rejected: an operator run that asks for
 * a scoped push gets an ordinary PR push, and the audit says so.
 */
export function stripOperatorEscapeHatches(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const clean = { ...source };
  const stripped = [];
  for (const field of OPERATOR_FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(clean, field)) {
      delete clean[field];
      stripped.push(field);
    }
  }
  return { body: clean, stripped };
}

/** Has this operator token stayed under its daily ceiling? */
export function operatorWithinDailyCap(turnsToday, cap = OPERATOR_DAILY_TURN_CAP) {
  const used = Number(turnsToday) || 0;
  const limit = Number(cap) || OPERATOR_DAILY_TURN_CAP;
  return used < limit;
}

/**
 * A stable, non-reversible label for a token, for logs and CLI output.
 *
 * Printed instead of any part of the token so a run can be correlated without
 * the value ever reaching a transcript — this workspace has leaked a live API
 * key and a live embed token into chat logs, and a prefix of the credential is
 * still part of the credential.
 */
export function operatorTokenFingerprint(value) {
  return `opr_…${hashOperatorToken(value).slice(0, 8)}`;
}
