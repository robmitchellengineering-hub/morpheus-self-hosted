// Self-dev DB migrations (SELF-DEV-V2 A2).
//
// A self-dev change that alters server/prisma/schema.prisma must ship a
// matching idempotent DDL file named `server/prisma/selfdev-<slug>.sql` in the
// SAME change. The coder is instructed to (scopedContextNote / KNOWN-HAZARDS),
// and pushSelfDevToGithub blocks a schema change that doesn't include one.
//
// After the change lands, applySelfDevMigrations.js runs any selfdev-*.sql not
// already recorded in the `self_dev_migrations` tracking table — but ONLY if
// every statement is additive (CREATE TABLE / ADD COLUMN / CREATE INDEX /
// CREATE TYPE / ALTER TYPE ADD VALUE / …). Anything with DROP, RENAME, or an
// ALTER COLUMN type change is left for a human to run against Supabase, since
// destructive DDL needs coordinating with the code deploy and can't be safely
// auto-applied.
//
// The backend container has prod deps only (no prisma CLI), so there's no
// `prisma migrate diff` here — the migration SQL is authored by the coder as a
// normal file, in the same dead-simple style as the existing
// server/prisma/*.sql files, and reviewed by the operator before the push.

export const SCHEMA_PATH = 'server/prisma/schema.prisma';
export const MIGRATION_RE = /^server\/prisma\/selfdev-[a-z0-9][a-z0-9-]*\.sql$/i;

// Statement-level allowlist — self-dev only ever adds schema, never rewrites it.
const ADDITIVE = [
  /^create\s+table\s+(if\s+not\s+exists\s+)?/i,
  /^create\s+(unique\s+)?index\s+(concurrently\s+)?(if\s+not\s+exists\s+)?/i,
  /^alter\s+table\s+[^\s]+\s+add\s+column\s+(if\s+not\s+exists\s+)?/i,
  /^alter\s+table\s+[^\s]+\s+add\s+constraint\s+/i,
  /^create\s+type\s+/i,
  /^alter\s+type\s+[^\s]+\s+add\s+value\s+/i,
  /^create\s+extension\s+(if\s+not\s+exists\s+)?/i,
  /^comment\s+on\s+/i,
];

export function splitStatements(sql) {
  return String(sql || '')
    .replace(/^\s*--.*$/gm, '')       // strip line comments
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function classifyMigration(sql) {
  const stmts = splitStatements(sql);
  const risky = stmts.filter((s) => !ADDITIVE.some((re) => re.test(s)));
  return { additive: stmts.length > 0 && risky.length === 0, stmts, riskyStatements: risky };
}

export async function ensureMigrationTable(prisma) {
  await prisma.$executeRawUnsafe(
    `create table if not exists self_dev_migrations (
       filename text primary key,
       statement_count integer not null default 0,
       applied_date timestamp(3) not null default now()
     )`,
  );
}

export async function appliedMigrationNames(prisma) {
  try {
    const rows = await prisma.$queryRawUnsafe('select filename from self_dev_migrations');
    return new Set(rows.map((r) => r.filename));
  } catch {
    return new Set();
  }
}
