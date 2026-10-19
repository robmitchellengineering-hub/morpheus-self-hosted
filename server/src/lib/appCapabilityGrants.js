// Per-app capability grants — the storage half of "a generated app may use one
// named capability against the operator's own connection".
//
// WHAT A GRANT IS
//
// One row says: *this user* approved that *this app* may do *this capability*
// (today, exactly one: upload a file to the user's Drive) *through the user's own
// Google Drive connection*. The row stores the token's SHA-256 and never the
// token; the token itself is shown once, at creation, to whoever is setting the
// app up.
//
// WHY IT IS ITS OWN TABLE AND NOT A widgetToken ROW
//
// The shape looks like lib/widgetToken.js — prefix, token_hash, revoked,
// last_used_at — and this module deliberately mirrors it. It is a separate table
// because the two answer different questions and the difference is security-
// bearing:
//
//   * A widget token is resolved by the functions dispatcher into
//     `req.widget`, and the widget path pins `projectId` from the token. This
//     grant is resolved by ONE purpose-built endpoint (routes/appCapability.routes.js)
//     and is checked against an `app_id` the caller must NAME, so "a token for app
//     A cannot act on app B" is a checked fact rather than a consequence of a
//     pinned body field.
//   * The grant carries an app-scoped identity (`app_id`) that a widget token has
//     no concept of, and the capability registry (lib/appCapability.js) is a
//     different namespace from WIDGET_SCOPE_FUNCTIONS, which names Morpheus
//     functions. Folding app capabilities into that list would mean an app
//     grant's meaning depended on the widget dispatcher's rules.
//
// WHY A BACKEND MUST HOLD THE TOKEN
//
// A capability token can write to a user's Drive. Shipping one in a public web
// page would make it readable — and usable — by anyone who opens that page. So
// the endpoint that accepts it is a server-to-server endpoint: the app's backend
// holds the token and presents it. This is not a limitation worked around in this
// module; it is why the created-token response says so in as many words, and why
// the build-time honesty text routes a static app to its own OAuth client instead.
//
// MIGRATION: server/prisma/selfdev-app-capability-grants.sql (hazard H8). It is
// additive and is NOT applied by this change. Every read below therefore treats a
// missing table as "this feature is not switched on yet" and says so, rather than
// throwing: the endpoint is reached only with a token, and the only row that could
// ever exist in this table is one created after the migration lands — so a missing
// table degrades to a clear 503, not to a broken read of some other page.
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { APP_CAPABILITY_PREFIX, APP_CAPABILITIES, isKnownCapability, capabilityTokenHash, appIdForProject } from './appCapability.js';

/** A row's hash, at rest and in flight. Never a token. */
export function hashCapabilityToken(raw) {
  return capabilityTokenHash(raw);
}

/**
 * Is the grants table absent on this database?
 *
 * P2021 (no such table) and P2022 (no such column) are the same condition from a
 * caller's point of view here, and the message shapes are matched too because
 * Prisma's error text differs between a generated client that lacks the model
 * entirely and one that has it against an unmigrated database.
 */
export function isMissingGrantTable(err) {
  const m = err && typeof err.message === 'string' ? err.message : '';
  return err?.code === 'P2021' || err?.code === 'P2022'
    || /relation\s+"?app_capability_grants"?\s+does not exist/i.test(m)
    || /Cannot read properties of undefined \(reading '(find|findFirst|create|update|updateMany)/i.test(m);
}

/** The one sentence a caller gets when the migration has not been applied. */
export const GRANTS_TABLE_MISSING_MESSAGE =
  'App capability grants are not set up on this deployment yet. The operator needs to apply '
  + 'server/prisma/selfdev-app-capability-grants.sql — Morpheus will not run that SQL itself.';

/**
 * Create a grant and return the one-time token.
 *
 * The raw token is generated here, hashed immediately, and returned exactly once;
 * only `token_hash` is written. Callers must show it to the operator and then
 * forget it — the response deliberately carries no field that could reconstruct it.
 *
 * Unknown capability names are dropped rather than stored, so a grant cannot be
 * minted carrying a capability the endpoint would then have to refuse.
 */
export async function createCapabilityGrant(projectId, userId, { label, capabilities } = {}) {
  const clean = (Array.isArray(capabilities) ? capabilities : []).filter(isKnownCapability);
  if (clean.length === 0) {
    throw Object.assign(
      new Error(`Pick at least one capability to grant. Known: ${Object.keys(APP_CAPABILITIES).join(', ')}.`),
      { status: 400, code: 'NO_CAPABILITIES' },
    );
  }
  const secret = APP_CAPABILITY_PREFIX + crypto.randomBytes(32).toString('hex');
  try {
    const row = await prisma.appCapabilityGrant.create({
      data: {
        created_by_id: userId,
        project_id: projectId,
        app_id: appIdForProject(projectId),
        token_prefix: secret.slice(0, APP_CAPABILITY_PREFIX.length + 8),
        token_hash: hashCapabilityToken(secret),
        label: label ? String(label).slice(0, 80) : null,
        capabilities: clean.join(','),
      },
    });
    return {
      // The only time this value exists in a response. Never logged.
      token: secret,
      id: row.id,
      appId: row.app_id,
      prefix: row.token_prefix,
      capabilities: row.capabilities.split(','),
      label: row.label,
      created_date: row.created_date,
    };
  } catch (err) {
    if (isMissingGrantTable(err)) throw Object.assign(new Error(GRANTS_TABLE_MISSING_MESSAGE), { status: 503, code: 'GRANTS_NOT_MIGRATED' });
    throw err;
  }
}

/**
 * Look a presented token up by its hash. Returns the raw rows (usually 0 or 1) —
 * the authorisation decision itself lives in lib/appCapability.js's pure
 * `resolveCapabilityGrant`, so the cross-app and cross-user rules are testable
 * without a database.
 *
 * `last_used_at` is bumped fire-and-forget: a slow audit write must never delay or
 * fail the capability call it is recording.
 */
export async function findCapabilityGrantsByToken(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(APP_CAPABILITY_PREFIX)) return [];
  try {
    const rows = await prisma.appCapabilityGrant.findMany({ where: { token_hash: hashCapabilityToken(raw) } });
    if (rows.length) {
      prisma.appCapabilityGrant
        .update({ where: { id: rows[0].id }, data: { last_used_at: new Date() } })
        .catch(() => {});
    }
    return rows;
  } catch (err) {
    if (isMissingGrantTable(err)) return [];
    throw err;
  }
}

/** The owner of a grant, resolved fresh so a deleted account cannot linger. */
export async function grantOwner(grant) {
  if (!grant?.created_by_id) return null;
  return prisma.user.findUnique({ where: { id: grant.created_by_id } });
}

/**
 * The grants for one project, for the operator's list. The token is not in this
 * shape and cannot be added to it — there is no column holding it.
 */
export async function listCapabilityGrants(projectId, userId) {
  try {
    const rows = await prisma.appCapabilityGrant.findMany({
      where: { project_id: projectId, created_by_id: userId },
      orderBy: { created_date: 'desc' },
    });
    return rows.map(publicGrant);
  } catch (err) {
    if (isMissingGrantTable(err)) return [];
    throw err;
  }
}

/** Revoke one grant, scoped to its owner. Idempotent; throws 404 when not theirs. */
export async function revokeCapabilityGrant(grantId, projectId, userId) {
  try {
    const res = await prisma.appCapabilityGrant.updateMany({
      where: { id: grantId, project_id: projectId, created_by_id: userId },
      data: { revoked: true },
    });
    if (!res.count) {
      throw Object.assign(new Error('That grant is not one of this project\'s grants.'), { status: 404, code: 'NO_SUCH_GRANT' });
    }
    return { revoked: true };
  } catch (err) {
    if (isMissingGrantTable(err)) throw Object.assign(new Error(GRANTS_TABLE_MISSING_MESSAGE), { status: 503, code: 'GRANTS_NOT_MIGRATED' });
    throw err;
  }
}

/** The public shape of a grant. Deliberately no token, hash, prefix-only display. */
export function publicGrant(row) {
  return {
    id: row.id,
    appId: row.app_id,
    prefix: row.token_prefix,
    label: row.label,
    capabilities: String(row.capabilities ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    revoked: row.revoked,
    last_used_at: row.last_used_at,
    created_date: row.created_date,
  };
}
