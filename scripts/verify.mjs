// ONE command for the whole gate — so no step can be skipped or forgotten.
//
// WHY THIS EXISTS
//
// The two production breaks on 2026-09-19 (H12, the boot failure; H11, the
// missing column) both passed every check that was *run* — because the
// decisive check was never run. A single entrypoint that runs them all, in
// order, and reports a clear pass/fail/not-verified for each, is the guard
// against "I ran the tests and they were green" meaning anything less than
// "the server boots and the database matches".
//
// Run:  node scripts/verify.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Hard gates — any failure here fails the whole run.
const HARD = [
  'verify-drift.mjs',
  'verify-cors.mjs',
  'verify-context.mjs',
  'verify-dump-classify.mjs',
  'verify-insight-optout.mjs',
  'verify-seo.mjs',
  'verify-pairing.mjs',
  'verify-working-copy.mjs',
  'verify-keywords.mjs',
  'verify-prod-sql.mjs',
  'verify-server-imports.mjs',
  'boot-smoke.mjs',
];

const results = [];
for (const script of HARD) {
  const r = spawnSync(process.execPath, [resolve(HERE, script)], { stdio: 'inherit' });
  results.push({ name: script, status: r.status });
}

// The production drift check is reported separately: exit 2 means "could not
// reach production", which is NOT a pass and is called out loudly, but it only
// blocks a merge when the change touches schema.prisma (see the rule in
// morpheus-dev-protocol / H11).
const drift = spawnSync(process.execPath, [resolve(HERE, 'verify-schema-prod.mjs')], { stdio: 'inherit' });
results.push({ name: 'verify-schema-prod.mjs', status: drift.status });

console.log('\n──────────────────────────────');
console.log('Summary');
for (const { name, status } of results) {
  const label = status === 0 ? 'PASS' : status === 2 ? 'NOT VERIFIED (no prod credential)' : `FAIL (${status})`;
  console.log(`  ${label.padEnd(30)} ${name}`);
}

const hardFailures = results.filter((r) => HARD.includes(r.name) && r.status !== 0);
const driftBlocking = drift.status === 1;

if (hardFailures.length || driftBlocking) {
  console.log('\n  ✗ verify failed — fix before merging.\n');
  process.exit(1);
}
console.log('\n  ✓ all hard gates passed.\n');
