// Published verification numbers must match the code they describe.
//
// WHY THIS EXISTS
//
// "130 automated guards" was typed into three places while the repo held 131, and a
// hand-written "502 recorded mutation tests" sat beside the code's 503. The verification
// page (public/verification.html) injects its numbers at build time, so it cannot drift;
// this guard extends the same guarantee to the copy that is NOT injected: the capability
// body in src/lib/morpheusCapabilities.json (which feeds the landing prerender, llms.txt,
// JSON-LD and the load screen) and the hand-written results block in src/pages/Projects.jsx.
// A hardcoded count drifts the moment a guard or a mutation is added, so both are read from
// the code and compared against the copy. The design-plan doc is auto-generated from the
// same JSON, so it is covered by pinning the JSON.
//
// Run:  node scripts/verify-guard-count-copy.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATIONS } from './guard-mutations.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// The same counts scripts/seo-static.mjs injects into the verification page — the single
// source of truth for "how many guards / mutations do we actually have".
const guardCount = readdirSync(join(ROOT, 'scripts'))
  .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs')).length;
const mutationCount = MUTATIONS.length;

// [file, metric] — every published "<N> <metric>" figure this guard owns. Each metric is
// compared against its own count so a wrong number cannot hide behind a right one.
const SITES = [
  ['src/lib/morpheusCapabilities.json', 'automated guards'],
  ['src/pages/Projects.jsx', 'automated guards'],
  ['src/pages/Projects.jsx', 'recorded mutation tests'],
];

let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — copy says ${got}, code has ${want}`}`);
  if (!ok) failures++;
}

for (const [path, metric] of SITES) {
  const want = metric === 'automated guards' ? guardCount : mutationCount;
  const text = read(path);
  const found = [...text.matchAll(new RegExp(`(\\d+) ${metric}`, 'g'))];
  if (found.length === 0) {
    check(`${path}: a "${metric}" figure is present`, 'missing', want);
    continue;
  }
  for (const m of found) check(`${path}: ${metric}`, Number(m[1]), want);
}

if (failures) {
  console.error(`\n  ✗ ${failures} published verification number(s) drifted from the code.\n`);
  process.exit(1);
}
console.log(`\n  ✓ published counts match the code: ${guardCount} guards, ${mutationCount} mutation tests.\n`);
