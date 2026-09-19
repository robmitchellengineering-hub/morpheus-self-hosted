// Detect drift between server/prisma/schema.prisma and the LIVE production
// database — the thing that made Rob's constructs disappear for eight hours.
//
// WHY THIS EXISTS — H11, confirmed in the wild on 2026-09-19
//
// A column (`projects.synced_commit`) shipped in schema.prisma, its migration
// sat unrun, and the entity engine — which reads with no `select` — threw
// P2022 on every construct load, rendering as "The Matrix is empty". Green CI
// could not see it: CI never knows whether a hand-run migration was actually
// applied. This is the check that does.
//
// It diffs the live database against the schema using Prisma's own diff engine
// (no reimplementation of schema parsing, which would be its own source of
// bugs) and reports anything the schema has that production lacks.
//
// Exit codes are DELIBERATELY distinct, because a check that is skipped must
// never look like a check that passed:
//   0  no drift — schema and production agree
//   1  drift — the schema has columns/tables production does not. This is the
//      H11 condition and BLOCKS a merge.
//   2  no credential — cannot reach production. Treat as "not verified", never
//      as "passed".
//
// Run:  node scripts/verify-schema-prod.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SERVER = resolve(REPO, 'server');
const SCHEMA = resolve(SERVER, 'prisma', 'schema.prisma');
const ENV_FILE = resolve(SERVER, '.env.prodsql');
const PRISMA = resolve(SERVER, 'node_modules', '.bin', 'prisma');

if (!existsSync(ENV_FILE)) {
  console.error('\n  ⚠  NOT VERIFIED — server/.env.prodsql is missing, so production drift could not be checked.');
  console.error('     This is not a pass. If the change touches schema.prisma, it is blocked until this runs.\n');
  process.exit(2);
}

process.loadEnvFile(ENV_FILE);
const url = process.env.PROD_DATABASE_URL;
if (!url) {
  console.error('\n  ⚠  NOT VERIFIED — PROD_DATABASE_URL is unset in server/.env.prodsql.\n');
  process.exit(2);
}

// "Changes to turn PRODUCTION into the SCHEMA." Anything ADDed here is a column
// or table the schema expects but production does not have — the H11 killer.
let diff;
try {
  diff = execFileSync(
    PRISMA,
    ['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', SCHEMA, '--script'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
} catch (err) {
  console.error(`\n  ⚠  NOT VERIFIED — migrate diff failed (${err?.message?.split('\n')[0] || err}).\n`);
  process.exit(2);
}

if (/empty migration/i.test(diff)) {
  console.log('\n  ✓ schema.prisma and the production database agree — no drift.\n');
  process.exit(0);
}

// Missing in production: the blocking direction.
const missing = diff
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => /^(ALTER TABLE .* ADD|CREATE TABLE|CREATE INDEX|CREATE TYPE|CREATE ENUM|CREATE SEQUENCE)/.test(l));

console.error(`\n  ✗ DRIFT — schema.prisma has ${missing.length} object(s) that production is missing:\n`);
for (const line of missing) console.error(`    ${line}`);
console.error('\n  This is hazard H11: the code knows about these, the database does not,');
console.error('  and any read with no explicit `select` will throw P2022 in production.');
console.error('  Apply the matching server/prisma/*.sql migration before merging.\n');
process.exit(1);
