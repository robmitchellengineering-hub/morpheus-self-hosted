// Assert every script CI runs in the NO-INSTALL guards job can actually load
// without an install.
//
// WHY THIS EXISTS — 2026-09-19, second module-load failure in one day
//
// scripts/verify-billing-clamp.mjs was added to the guards job and imported
// splitOvershoot from server/src/lib/billing.js. That passed locally and killed
// CI:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@prisma/client'
//   imported from server/src/db.js
//
// billing.js reaches the Prisma client through db.js. The guards job runs
// without `npm install` on purpose (hazard H4 — server/package-lock.json is
// untracked, so it *cannot* install), so the whole job went red.
//
// verify-server-imports.mjs could not catch it: every RELATIVE import resolved
// perfectly. The failure was a PACKAGE import, reached transitively. That is
// the same module-load class as H12, one level subtler.
//
// So this walks the guards job's scripts and fails if any of them can reach a
// bare package specifier. A check is only "pure" if it is pure transitively.
//
// Run:  node scripts/verify-guards-no-install.mjs
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI = resolve(REPO, '.github/workflows/ci.yml');

const STATIC_IMPORT = /^[ \t]*import\s+(?:[^'"\n]*\sfrom\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /^[ \t]*(?!\/\/)[^'"\n]*\bimport\(\s*['"]([^'"]+)['"]/gm;

let failures = 0;
let checks = 0;
const check = (name, actual, expected) => {
  checks++;
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
};

const yaml = readFileSync(CI, 'utf8');
const lines = yaml.split('\n');

// Slice out the `guards:` job — from its line to the next top-level job key.
const start = lines.findIndex((l) => /^  guards:/.test(l));
if (start < 0) {
  console.error('\n  ✗ could not find the `guards:` job in ci.yml — this check would silently pass.\n');
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^  [A-Za-z0-9_-]+:/.test(lines[i])) { end = i; break; }
}
const guardsJob = lines.slice(start, end).join('\n');

// `run: node scripts/<name>.mjs`
const scripts = [...guardsJob.matchAll(/node\s+(scripts\/[\w.-]+\.mjs)/g)].map((m) => m[1]);
check('the guards job runs at least one script', scripts.length > 0, true);

/** Every module reachable from `entry` via relative imports (excluding node: builtins). */
function reachableModules(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of [...source.matchAll(STATIC_IMPORT), ...source.matchAll(DYNAMIC_IMPORT)]) {
      const spec = m[1];
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec));
    }
  }
  return seen;
}

console.log(`\nNo-install guard — checking ${scripts.length} script(s) from the CI guards job\n`);

const offenders = [];
for (const script of scripts) {
  const entry = resolve(REPO, script);
  const modules = reachableModules(entry);
  for (const mod of modules) {
    const source = readFileSync(mod, 'utf8');
    for (const m of [...source.matchAll(STATIC_IMPORT), ...source.matchAll(DYNAMIC_IMPORT)]) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      offenders.push({ script, from: relative(REPO, mod), pkg: spec });
    }
  }
  console.log(`  ${script}  →  ${modules.size} module(s) reached`);
}

console.log('');
for (const o of offenders) {
  console.log(`  FAIL  ${o.script} transitively imports the package "${o.pkg}" via ${o.from}`);
}
check('no guards-job script can reach a package import', offenders.length, 0);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n  A script in the no-install guards job must not pull in a runtime dependency.');
  console.log('  Extract the pure logic into its own module with no imports — that is how');
  console.log('  deckDumpClassify / prodSqlGuard / billingClamp are structured.\n');
  process.exit(1);
}
console.log('all good\n');
