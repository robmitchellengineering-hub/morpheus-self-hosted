#!/usr/bin/env node
// Hand-run production migrations against Supabase.
//
//   node scripts/prod-sql.mjs prisma/selfdev-add-synced-commit.sql --dry-run
//   node scripts/prod-sql.mjs prisma/selfdev-add-synced-commit.sql
//
// WHY THIS EXISTS
//
// KNOWN-HAZARDS.md H8: the backend deploy only runs `prisma generate`, so every
// schema change has to be applied to Supabase by hand. H11 explains why leaving
// one unrun is not a cosmetic problem — an unapplied column on an entity the
// frontend lists takes the whole page down — and four migrations were once left
// typed-and-waiting until Command Deck's data load broke in production. This
// exists so applying them is a one-liner instead of a browser session.
//
// SETUP (once)
//
//   server/.env.prodsql        (gitignored — verified by scripts/verify-prod-sql.mjs)
//     PROD_DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres
//
//   Use Supabase → Project Settings → Database → Connection string → URI.
//   Prefer the **Session pooler** URI: the direct `db.<ref>.supabase.co` host is
//   IPv6-only on newer projects and may be unreachable.
//
// SAFETY
//
// The decision about what may run lives in src/lib/prodSqlGuard.js, which is
// pure and asserted by scripts/verify-prod-sql.mjs:
//   - only additive DDL (reusing self-dev's own allowlist) — DROP/TRUNCATE/
//     DELETE/RENAME/ALTER COLUMN are refused
//   - a URL pointing at localhost is refused, so a misconfigured file cannot
//     quietly run a migration against the local dev database
//   - the password is never printed
// Run with --dry-run first; it prints the target and every statement and exits
// without connecting.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { describeDatabaseUrl, isLocalDatabaseUrl, parseDatabaseUrl, reviewSql } from '../src/lib/prodSqlGuard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..');
const ENV_FILE = resolve(SERVER_ROOT, '.env.prodsql');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
// Widens the guard to allow a bounded UPDATE/DELETE — the data-repair channel.
// Explicit flag only; never inferred from the SQL, so a data write can never
// ride along unnoticed on a schema change.
const dataRepair = args.includes('--data-repair');
const fileArg = args.find((a) => !a.startsWith('--'));

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

if (!fileArg) {
  fail('usage: node scripts/prod-sql.mjs <path-to.sql> [--dry-run] [--data-repair]');
}

const sqlPath = resolve(process.cwd(), fileArg);
if (!existsSync(sqlPath)) fail(`no such SQL file: ${sqlPath}`);

// `.env.prodsql` is deliberately not `.env`: the dev server loads `.env`, and a
// production credential sitting in it would point `npm run dev` at production.
if (!existsSync(ENV_FILE)) {
  fail(
    `missing ${ENV_FILE}\n\n`
    + '    Create it with one line (it is gitignored):\n\n'
    + '      PROD_DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres\n\n'
    + '    Supabase → Project Settings → Database → Connection string → URI.\n'
    + '    Prefer the Session pooler URI (the direct db.<ref>.supabase.co host is IPv6-only).',
  );
}
process.loadEnvFile(ENV_FILE);

const url = process.env.PROD_DATABASE_URL;
if (!url) fail(`${ENV_FILE} exists but does not set PROD_DATABASE_URL`);

if (!parseDatabaseUrl(url)) {
  fail(
    'PROD_DATABASE_URL could not be parsed.\n'
    + '    If the password contains #, ? or / it must be percent-encoded — refusing to guess,\n'
    + '    because a misread URL is how a migration reaches the wrong database.',
  );
}
if (isLocalDatabaseUrl(url)) {
  fail(
    `refusing to run: PROD_DATABASE_URL points at ${describeDatabaseUrl(url)}, which is a LOCAL database.\n`
    + '    This script exists to reach production; a local target almost certainly means the wrong\n'
    + '    connection string was pasted. Use server/.env + npm run dev:db for the dev database.',
  );
}

const sql = readFileSync(sqlPath, 'utf8');
const review = reviewSql(sql, { allowDataRepair: dataRepair });

console.log(`\n  target   ${describeDatabaseUrl(url)}`);
console.log(`  file     ${fileArg}`);
console.log(`  mode     ${review.mode || (dataRepair ? 'data-repair' : 'additive')}`);
console.log(`  statements  ${review.statements.length}`);

if (!review.ok) {
  console.error(`\n  ✗ refused: ${review.reason}`);
  if (review.riskyStatements.length) {
    console.error('\n    Offending statement(s):');
    for (const s of review.riskyStatements) console.error(`      - ${s.split('\n')[0].slice(0, 110)}`);
    console.error(
      '\n    Destructive or ambiguous DDL needs coordinating with the code deploy and is\n'
      + '    deliberately never automated here (see lib/selfDevMigrations.js and H8).',
    );
  }
  console.error('');
  process.exit(1);
}

console.log('');
for (const [i, s] of review.statements.entries()) {
  console.log(`  [${i + 1}] ${s.split('\n').join(' ').slice(0, 110)}`);
}

if (dryRun) {
  console.log('\n  dry run — nothing was executed.\n');
  process.exit(0);
}

const prisma = new PrismaClient({ datasources: { db: { url } }, log: ['error'] });
let applied = 0;
try {
  for (const statement of review.statements) {
    await prisma.$executeRawUnsafe(statement);
    applied++;
    console.log(`  ✓ statement ${applied} applied`);
  }
  console.log(`\n  done — ${applied}/${review.statements.length} statement(s) applied to ${describeDatabaseUrl(url)}.\n`);
} catch (err) {
  console.error(`\n  ✗ failed after ${applied}/${review.statements.length} statement(s): ${err?.message || err}`);
  console.error(
    '\n    Statements already applied are idempotent by rule (IF NOT EXISTS), so fixing the\n'
    + '    cause and re-running is safe.\n',
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => {});
}
