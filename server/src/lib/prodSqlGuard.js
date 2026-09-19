// Pure guard logic for the hand-run production migration runner
// (server/scripts/prod-sql.mjs).
//
// WHY THIS EXISTS
//
// KNOWN-HAZARDS.md H8: the backend container only ever runs `prisma generate`,
// so every schema change has to be applied to Supabase by hand. That made Rob
// the bottleneck for every migration — and the failure mode of leaving one
// typed-and-waiting is not "the feature is missing", it is H11: an unapplied
// column on an entity the frontend lists takes the whole page down. Four
// migrations were once left unrun and Command Deck's main data load was
// silently broken in production as a result.
//
// So the operator asked for a way for the agent to run these directly. This is
// the guard that makes that safe: it decides what may be executed. Kept pure
// and dependency-free so scripts/verify-prod-sql.mjs can assert it in CI's
// no-install guards job.
//
// TWO DECISIONS, BOTH DELIBERATELY CONSERVATIVE:
//
//   1. WHAT may run is not redefined here. `classifyMigration` from
//      lib/selfDevMigrations.js already owns the definition of "additive" for
//      the self-dev auto-apply path, so this reuses it rather than growing a
//      second opinion that could drift. A statement is refused if it is not on
//      that allowlist — DROP, TRUNCATE, DELETE, RENAME and ALTER COLUMN type
//      changes all fail it.
//   2. WHERE it runs is checked. A runner holding production credentials must
//      never silently point at the local dev database, and vice versa: running
//      a migration against the wrong database is exactly the class of mistake
//      that is only discovered afterwards.
import { classifyMigration } from './selfDevMigrations.js';

// Hosts that are definitionally not production. `host.docker.internal` is in
// here because it resolves to the host machine — reaching the dev Postgres from
// inside a container is a local target, not a remote one.
//
// This list is not the whole story: see isLocalHost(), which also covers the
// whole 127.0.0.0/8 block, every spelling of IPv6 loopback, and `.localhost`.
const LOCAL_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  'host.docker.internal',
]);

/** Order-independent view of a host for comparison. */
function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

/**
 * Is this hostname a local target?
 *
 * Deliberately broader than a set lookup, because the obvious spellings are not
 * the only ones: `127.0.0.2` is loopback just as much as `127.0.0.1` (the whole
 * 127.0.0.0/8 block is), and IPv6 loopback can be written `::1` or fully
 * expanded as `0:0:0:0:0:0:0:1`. A guard that only catches the tidy spellings
 * would give false confidence, which is worse than no guard.
 */
export function isLocalHost(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  if (LOCAL_HOSTS.has(h)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // 127.0.0.0/8
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true; // IPv6 loopback
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true; // mDNS — a machine on the same LAN
  return false;
}

/**
 * Parse a Postgres connection URL. Returns null rather than throwing, so
 * callers must decide explicitly what an unusable URL means.
 *
 * @param {string} url
 * @returns {{host: string, port: string, database: string, user: string}|null}
 */
export function parseDatabaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    // An unencoded password (a `#`, `?` or `/` in it) lands here. Refusing is
    // correct: guessing at the intent of a URL we cannot parse is how a
    // migration reaches the wrong database.
    return null;
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return null;
  const database = parsed.pathname.replace(/^\//, '');
  if (!parsed.hostname || !database) return null;
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    database,
    user: parsed.username ? decodeURIComponent(parsed.username) : '',
  };
}

/** Is this URL pointed at a local database rather than a remote one? */
export function isLocalDatabaseUrl(url) {
  const info = parseDatabaseUrl(url);
  if (!info) return false; // unparseable is handled separately; not reported as "local"
  return isLocalHost(info.host);
}

/**
 * A human-readable target with the password removed — safe to print, and the
 * thing the operator actually checks before agreeing to a run.
 *
 * @param {string} url
 * @returns {string} e.g. `postgres@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`
 */
export function describeDatabaseUrl(url) {
  const info = parseDatabaseUrl(url);
  if (!info) return '(unparseable connection string)';
  return `${info.user || '(no user)'}@${info.host}:${info.port}/${info.database}`;
}

/**
 * Decide whether a block of SQL may be run against production.
 *
 * @param {string} sql
 * @returns {{ok: boolean, statements: string[], riskyStatements: string[], reason: string|null}}
 */
export function reviewSql(sql) {
  const { additive, stmts, riskyStatements } = classifyMigration(sql);

  if (!stmts.length) {
    return { ok: false, statements: [], riskyStatements: [], reason: 'the file contains no statements' };
  }
  if (!additive) {
    return {
      ok: false,
      statements: stmts,
      riskyStatements,
      reason: `${riskyStatements.length} statement(s) are not additive — these need a human, not a script`,
    };
  }
  return { ok: true, statements: stmts, riskyStatements: [], reason: null };
}
