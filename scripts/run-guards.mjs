#!/usr/bin/env node
// run-guards.mjs — runs every guard in the "guards (no install)" job, from ONE CI step.
//
// The list lives in scripts/guards-list.json (generated from the guards job), NOT ci.yml — so this
// script cannot self-reference (reading ci.yml would find its own `run:` line and recurse forever).
// Each guard is run as a subprocess, in list order, reported by name; exit non-zero if any fail.
//
// H17 discipline: a missing manifest, an empty list, or a guard file that does not exist is a
// FAILURE — a check that never ran must never read as a pass.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'scripts', 'guards-list.json');

let guards;
try {
  guards = JSON.parse(readFileSync(MANIFEST, 'utf8')).guards;
} catch {
  console.error(`run-guards: could not read ${MANIFEST} — refusing to report a pass.`);
  process.exit(2);
}
if (!Array.isArray(guards) || guards.length === 0) {
  console.error('run-guards: guards-list.json holds no guards — refusing to report a pass.');
  process.exit(2);
}

// Every guard in the list must actually exist (H17: a stale list must not silently drop a guard).
for (const g of guards) {
  try { readFileSync(join(ROOT, 'scripts', g)); }
  catch { console.error(`run-guards: guard file missing: scripts/${g}`); process.exit(2); }
}

const started = Date.now();
let fails = 0;
for (const g of guards) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', g)], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  const ok = r.status === 0 && !r.error;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${g}`);
  if (!ok) {
    if (r.error) console.log(`      spawn error: ${r.error.message}`);
    if (r.status !== null && r.status !== 0) console.log(`      exit ${r.status}`);
    const tail = (s) => String(s || '').split('\n').filter(Boolean).slice(-12).map((l) => `      ${l}`).join('\n');
    if (r.stdout) console.log(tail(r.stdout));
    if (r.stderr) console.log(tail(r.stderr));
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${guards.length - fails}/${guards.length} guards passed in ${secs}s`);
process.exit(fails ? 1 : 0);
