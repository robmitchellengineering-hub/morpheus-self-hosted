#!/usr/bin/env node
// run-guards.mjs — runs every guard in the "guards (no install)" job, from ONE CI step.
//
// WHY. The guards job had ~130 individual GitHub Actions steps, one per guard, and every step
// carries ~5-10s of runner overhead (shell spawn + logging) on top of the guard's own ~0.2s.
// So a job whose actual work is ~90s took ~15 min. This runs the SAME list from a single step:
// it reads the guards job's own `run:` lines out of ci.yml — so adding a guard to the job needs
// no edit here — runs each in the same order, reports each by its step name, and exits non-zero
// if any guard fails.
//
// Install-free on purpose (the job installs nothing): node built-ins only.
//
// H17 discipline: if zero guard steps extract, or a guard fails to run, this is a FAILURE — a
// check that never ran must never read as a pass.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const section = ci.split(/^  guards:/m)[1];
if (!section) {
  console.error('run-guards: could not find the `guards:` job in ci.yml — refusing to report a pass.');
  process.exit(2);
}

// Line-parse the guards job: keep the current `- name:` and capture each single-line
// `run: node scripts/<x>.mjs [args]`. Multi-line `run: |` blocks (the LF checkout) are skipped.
const steps = [];
let current = null;
for (const line of section.split('\n')) {
  const name = line.match(/^\s+- name:\s*(.+)$/);
  if (name) { current = name[1].trim(); continue; }
  const run = line.match(/^\s+run:\s+(node\s+scripts\/[\w.-]+\.mjs(?:\s+[^\n]*)?)$/);
  if (run && current) steps.push({ name: current, cmd: run[1].trim() });
}
if (steps.length === 0) {
  console.error('run-guards: extracted zero `node scripts/…` steps from the guards job — refusing to report a pass.');
  process.exit(2);
}

const started = Date.now();
let fails = 0;
for (const { name, cmd } of steps) {
  const args = cmd.split(/\s+/).slice(1); // drop "node"
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  const ok = r.status === 0 && !r.error;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    if (r.error) console.log(`      spawn error: ${r.error.message}`);
    if (r.status !== null && r.status !== 0) console.log(`      exit ${r.status}`);
    const tail = (s) => String(s || '').split('\n').filter(Boolean).slice(-12).map((l) => `      ${l}`).join('\n');
    if (r.stdout) console.log(tail(r.stdout));
    if (r.stderr) console.log(tail(r.stderr));
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${steps.length - fails}/${steps.length} guards passed in ${secs}s`);
process.exit(fails ? 1 : 0);
