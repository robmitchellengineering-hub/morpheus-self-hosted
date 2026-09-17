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

export { ADMIN, PLUGIN_TENANT, WIDGET_BUILD };
