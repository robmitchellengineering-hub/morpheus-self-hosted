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
  maxTurnsPerHour: 20,          // even when funded — a scripted loop can't drain a balance
  maxSpendPerDayUsd: 25,
  repoAllowList: 'token-push-access', // resolved per-tenant: only repos their GitHub token can push to
});

const POLICIES = { admin: ADMIN, plugin_tenant: PLUGIN_TENANT };

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

export { ADMIN, PLUGIN_TENANT };
