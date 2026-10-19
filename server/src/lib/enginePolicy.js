// Engine policy (2026-09-10) — what a caller of the shared build/deliver
// engine is allowed to do. Self-dev runs as ADMIN (its behaviour today);
// an embedded plugin tenant runs as PLUGIN_TENANT. This is the `policy`
// argument the shared engine will take — see the "Self-Dev as a Plugin"
// scope doc.
//
// Nothing enforces the whole of this yet; it's pinned down now because the
// path deny-list is a security boundary (from the Valiant Music handoff:
// "a buggy or malicious push must not overwrite credentials or wipe the
// media library") and it must be identical wherever a write happens.

// Paths a plugin tenant's change may NEVER create, modify, or delete —
// enforced in code, independent of any repo's .gitignore. A WordPress
// delivery adapter also applies these before writing to disk.
export const PLUGIN_DENY_PATHS = [
  // secrets / config that live only on the server
  /(^|\/)wp-config\.php$/i,
  /(^|\/)\.env(\.|$)/i,
  // user content + anything regenerable — never the plugin's to touch
  /(^|\/)wp-content\/uploads(\/|$)/i,
  /(^|\/)wp-content\/(cache|upgrade|upgrade-temp-backup|wp-rocket-config)(\/|$)/i,
  // repo / VCS internals
  /(^|\/)\.git(\/|$)/i,
  // Morpheus's own operational surface — a tenant only ever touches their site
  /(^|\/)\.morpheus\/(secrets|billing)/i,
];

// The two policies. Fields are additive caps: absent/false = not allowed.
const ADMIN = Object.freeze({
  id: 'admin',
  label: 'Admin (self-dev)',
  allowForce: true,             // override a red verify / merge a red check
  allowDirectToMain: true,      // commit straight to the deploy branch
  allowMigrations: true,        // run DB migrations against the target
  allowInfraWrites: true,       // write server/ infra, CI config, etc.
  denyPaths: [],                // no extra restrictions
  allowPathPrefixes: null,      // null = no allow-list cap — any non-denied path is fine
  maxTurnsPerHour: Infinity,
  maxSpendPerDayUsd: Infinity,
  repoAllowList: null,          // null = any repo the token can push to
});

const PLUGIN_TENANT = Object.freeze({
  id: 'plugin_tenant',
  label: 'Plugin tenant',
  allowForce: false,            // never skip a gate
  allowDirectToMain: false,     // always via a PR
  allowMigrations: false,       // never touch the target's DB schema
  allowInfraWrites: false,      // site content + code only
  denyPaths: PLUGIN_DENY_PATHS,
  allowPathPrefixes: null,
  maxTurnsPerHour: 20,          // even when funded — a scripted loop can't drain a balance
  maxSpendPerDayUsd: 25,
  repoAllowList: 'token-push-access', // resolved per-tenant: only repos their GitHub token can push to
});

// 2026-09-17 (Rob: "leveraging self-dev's power and putting a small portion
// of it in the hands of users") — a Jarvis-triggered widget build. Unlike
// the two policies above, which only ever DENY named paths (everything else
// allowed), this one ALLOWS only a narrow set of paths (everything else
// denied) — see allowPathPrefixes handling in assertWritable below. Never
// restricts what a built widget's own code may CALL at runtime (e.g. any
// lib/deck*.js connection helper to read/synthesize a user's own connected
// data) — only which files the BUILD itself may create or edit.
const WIDGET_BUILD = Object.freeze({
  id: 'widget_build',
  label: 'Jarvis widget build',
  allowForce: false,
  allowDirectToMain: false,     // always via a PR — auto-merge-when-green already needs no human click
  allowMigrations: false,       // a widget requests new schema only through a human-reviewed path, not this one
  allowInfraWrites: false,
  denyPaths: [],
  // New widget UI components, new widget-specific backend functions (the
  // widgetXxx.js naming convention keeps this regex simple and greppable),
  // and the shared registry file every widget must be listed in to render
  // at all — that last one gets an EXTRA append-only diff guard at push
  // time (see pushSelfDevToGithub.js) since it's shared by every user's
  // widgets, not owned by any one build.
  allowPathPrefixes: [
    /^src\/pages\/CommandDeck\/widgets\//,
    /^server\/src\/functions\/widget[A-Z]/,
    /^src\/pages\/CommandDeck\/deckWidgets\.js$/,
  ],
  maxTurnsPerHour: 20,
  maxSpendPerDayUsd: 25,
  repoAllowList: null,
});

const POLICIES = { admin: ADMIN, plugin_tenant: PLUGIN_TENANT, widget_build: WIDGET_BUILD };

export function resolvePolicy(id) {
  const p = POLICIES[id] || (id && typeof id === 'object' && id.id ? id : null);
  if (!p) throw Object.assign(new Error(`Unknown engine policy: ${id}`), { status: 400 });
  return p;
}

// Throws if `policy` forbids writing `path`. Called by every delivery
// adapter before it writes anything.
export function assertWritable(policy, path) {
  const p = resolvePolicy(policy);
  const denied = [...(p.denyPaths || [])].some((re) => re.test(path));
  if (denied) {
    throw Object.assign(new Error(`Policy "${p.id}" forbids writing ${path}`), { status: 403, code: 'POLICY_DENY_PATH' });
  }
  // allowPathPrefixes, when set, is the inverse of denyPaths: everything is
  // denied EXCEPT what matches. WIDGET_BUILD is the first policy to use
  // this — a narrow allow-list is a much smaller surface to get right than
  // trying to enumerate everything a scoped build must never touch. A path
  // this list explicitly allows (e.g. server/src/functions/widgetXxx.js) is
  // a deliberate, reviewed exception, so it also short-circuits the generic
  // infra-write check below rather than tripping it just for living under
  // server/.
  if (Array.isArray(p.allowPathPrefixes) && p.allowPathPrefixes.length > 0) {
    const allowed = p.allowPathPrefixes.some((re) => re.test(path));
    if (!allowed) {
      throw Object.assign(new Error(`Policy "${p.id}" only allows writing within its allowed paths — ${path} is outside that scope`), { status: 403, code: 'POLICY_OUTSIDE_SCOPE' });
    }
    return;
  }
  if (!p.allowInfraWrites && /(^|\/)(\.github\/workflows|server|infra|Dockerfile|docker-compose)/i.test(path)) {
    throw Object.assign(new Error(`Policy "${p.id}" forbids writing infrastructure file ${path}`), { status: 403, code: 'POLICY_DENY_INFRA' });
  }
}

// Partition a list of paths into { allowed, denied } without throwing —
// for a pre-flight report ("this change touches N files the plugin can't
// write; drop them or ask an admin").
export function partitionWritable(policy, paths) {
  const allowed = [];
  const denied = [];
  for (const path of paths) {
    try { assertWritable(policy, path); allowed.push(path); }
    catch { denied.push(path); }
  }
  return { allowed, denied };
}

// ── Which field is enforced where ────────────────────────────────────────────
// The header used to say only "nothing enforces the whole of this yet", which is
// true but useless: it does not say which half is real, so a reader cannot tell a
// guarantee from an intention. This is the honest map.
//
//   denyPaths          assertWritable()          every write, all policies
//   allowPathPrefixes  assertWritable()          every write, scoped policies
//   allowInfraWrites   assertWritable()          every write (skipped for a path
//                                                the allow-list already admits)
//   allowForce         evaluatePushPolicy()      pushSelfDevToGithub
//   allowDirectToMain  evaluatePushPolicy()      pushSelfDevToGithub
//   allowMigrations    the schema-needs-a-migration gate in
//                      pushSelfDevToGithub, which refuses a schema change unless
//                      the push is directToMain — so a policy forbidding
//                      directToMain cannot migrate either. It is enforced by
//                      consequence, not read by name: do not rely on it alone.
//   maxTurnsPerHour    lib/tenantPolicy.js       the WordPress path only
//   maxSpendPerDayUsd  lib/tenantPolicy.js       the WordPress path only
//   repoAllowList      lib/tenantPolicy.js       the WordPress path only
//
// The last three are the plugin-tenant story and are NOT enforced on the
// self-dev path, where the caps are Infinity by design — the only actor there is
// the workspace owner. If a scoped self-dev caller ever needs them, wire them
// through tenantPolicy the way the WordPress adapter did rather than inventing a
// second mechanism.

/**
 * May this push use `force` / `directToMain`?
 *
 * Pure — no I/O, no imports — so the rule is asserted against real values
 * instead of being read, the same shape as `evaluateDrift()` and for the same
 * reason (see scripts/verify-push-policy.mjs).
 *
 * `force` is the override that skips the esbuild verification gate;
 * `directToMain` commits straight to the deploy branch instead of opening a PR.
 * Both are ADMIN affordances. A scoped policy sets them false — and until this
 * existed, nothing read them: `pushSelfDevToGithub` honoured `body.force`
 * whatever the policy said, so those two fields documented a safety property
 * that was not actually enforced. That is the worst state for a policy field to
 * be in, because the code around it reads as though the check exists.
 *
 * @param {string|object} policyOrId
 * @param {{force?: boolean, directToMain?: boolean}} [request]
 * @returns {{reason: string, message: string}|null}  null = allowed
 */
export function evaluatePushPolicy(policyOrId, { force = false, directToMain = false } = {}) {
  const p = resolvePolicy(policyOrId);
  if (force && !p.allowForce) {
    return {
      reason: 'force-not-allowed',
      message: `Policy "${p.id}" does not allow force — the verification gate cannot be skipped on this path. Fix what verification reported, or ask an admin to push it.`,
    };
  }
  if (directToMain && !p.allowDirectToMain) {
    return {
      reason: 'direct-to-main-not-allowed',
      message: `Policy "${p.id}" requires a pull request — this change cannot be committed straight to the deploy branch.`,
    };
  }
  return null;
}

// The mirror image of assertWritable's allow-list check, phrased as a
// ship()-compatible exclude predicate: true for any path a scoped policy
// does NOT allow writing. An unscoped policy (allowPathPrefixes: null —
// ADMIN, PLUGIN_TENANT) never excludes anything extra here; its own
// denyPaths/infra checks are enforced separately at write time.
//
// Built for the self-dev push pipeline (KNOWN-HAZARDS.md H9): a scoped
// build's diff/deletion computation should never even consider a path
// outside its own scope, regardless of whether the local workspace's copy
// of that path is fresh or stale — see pushSelfDevToGithub.js.
export function scopeExcludeFor(policy) {
  const p = resolvePolicy(policy);
  if (!Array.isArray(p.allowPathPrefixes) || p.allowPathPrefixes.length === 0) return () => false;
  return (path) => !p.allowPathPrefixes.some((re) => re.test(path));
}

export { ADMIN, PLUGIN_TENANT, WIDGET_BUILD };
