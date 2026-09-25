// A change that breaks a caller must be caught by a script, not by asking a model.
//
// KNOWN-HAZARDS.md H1 is the incident this repo has actually suffered (a reshaped
// `lib/github.js` broke every importer at import time), and the same shape recurred in
// production on 2026-09-25 (`runAiAction.js` importing a name `reviewer.js` never exported).
// `findBrokenImports` answers it exactly, and `chatWithMorpheus.js` already ran it — but only
// inside the `isSelfDev` deep-verify gate, so a regular build turn checked each file's syntax
// in isolation and left "did this break a caller?" to the reviewer's judgement.
//
// This asserts the caller half now runs on every build, over the proposed state, and reports
// only what the change INTRODUCED.
//
// Dependency-free. Run:  node scripts/verify-caller-check.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCallerBreaks, applyFileOps, describeCallerBreaks } from '../server/src/lib/callerCheck.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const code = (p) => readFileSync(join(REPO, p), 'utf8').replace(/^[ \t]*\/\/.*$/gm, ' ');

const PROJECT = [
  { path: 'server/src/lib/github.js', content: 'export function getGithubToken() {}\nexport function pushFiles() {}\n' },
  { path: 'server/src/functions/compile.js', content: "import { getGithubToken } from '../lib/github.js';\nexport const x = getGithubToken;\n" },
  { path: 'server/src/lib/other.js', content: 'export const a = 1;\n' },
];

// ── The check itself ────────────────────────────────────────────────────────────────
const removed = findCallerBreaks(PROJECT, [
  { path: 'server/src/lib/github.js', action: 'update', content: 'export function pushFiles() {}\n' },
]);
check('removing an export a caller uses is caught',
  removed.length === 1 && removed[0].name === 'getGithubToken' && removed[0].importer === 'server/src/functions/compile.js',
  JSON.stringify(removed));
check('the report names the target, the missing name and the importer',
  /github\.js no longer exports getGithubToken, but .*compile\.js still imports it/.test(describeCallerBreaks(removed)[0] || ''),
  describeCallerBreaks(removed)[0]);
check('the broken importer is marked as NOT touched (so it is reported, not auto-fixed)',
  removed[0].touched === false);

check('a clean change produces nothing',
  findCallerBreaks(PROJECT, [{ path: 'server/src/lib/other.js', action: 'update', content: 'export const a = 2;\n' }]).length === 0);

check('adding an export produces nothing',
  findCallerBreaks(PROJECT, [{ path: 'server/src/lib/github.js', action: 'update', content: 'export function getGithubToken() {}\nexport function pushFiles() {}\nexport const added = 1;\n' }]).length === 0);

// The distinction that makes this safe to run on every build: an import that was ALREADY
// broken before the turn is not this turn's fault, and blaming it would fail builds for a
// pre-existing condition the coder cannot fix.
const withPreExisting = [...PROJECT, { path: 'server/src/functions/broken.js', content: "import { notThere } from '../lib/github.js';\n" }];
check('a PRE-EXISTING broken import is not blamed on this change',
  findCallerBreaks(withPreExisting, [{ path: 'server/src/lib/other.js', action: 'update', content: 'export const a = 3;\n' }]).length === 0);
check('…but the same turn breaking a NEW one is still caught',
  findCallerBreaks(withPreExisting, [{ path: 'server/src/lib/github.js', action: 'update', content: '' }]).some((b) => b.name === 'getGithubToken'));

check('a rename is caught as a removal plus an addition',
  findCallerBreaks(PROJECT, [{ path: 'server/src/lib/github.js', action: 'update', content: 'export function getGithubTokenRenamed() {}\nexport function pushFiles() {}\n' }]).length === 1);

check('deleting a whole file is caught',
  findCallerBreaks(PROJECT, [{ path: 'server/src/lib/github.js', action: 'delete' }]).some((b) => b.name === 'getGithubToken'));
check('an untouched importer that this change also fixed is not reported',
  findCallerBreaks(PROJECT, [
    { path: 'server/src/lib/github.js', action: 'update', content: 'export function pushFiles() {}\n' },
    { path: 'server/src/functions/compile.js', action: 'update', content: 'export const y = 1;\n' },
  ]).length === 0);
check('no ops means no work',
  findCallerBreaks(PROJECT, []).length === 0 && findCallerBreaks(PROJECT, undefined).length === 0);

check('applyFileOps applies create, update and delete',
  applyFileOps(PROJECT, [
    { path: 'server/src/lib/new.js', action: 'create', content: 'export const n = 1;\n' },
    { path: 'server/src/lib/other.js', action: 'update', content: 'export const a = 9;\n' },
    { path: 'server/src/lib/github.js', action: 'delete' },
  ]).map((f) => f.path).join(',') === 'server/src/functions/compile.js,server/src/lib/other.js,server/src/lib/new.js');

// ── Wiring: an exact check nobody calls is not a gate ───────────────────────────────
const chat = code('server/src/functions/chatWithMorpheus.js');
check('chatWithMorpheus runs the caller check', /findCallerBreaks\(/.test(chat));
check('…and imports it', /from '\.\.\/lib\/callerCheck\.js'/.test(chat));
// The whole point of the change: this must NOT sit inside the self-dev-only branch.
const deepGateAt = chat.indexOf('if (isSelfDev && fileOps.length > 0)');
const callerAt = chat.indexOf('findCallerBreaks(');
check('the caller check is OUTSIDE the self-dev-only deep-verify gate',
  deepGateAt > -1 && callerAt > -1 && Math.abs(callerAt - deepGateAt) > 40,
  `deepGate@${deepGateAt} caller@${callerAt}`);
check('…and reuses the existing cross-file checker rather than a second implementation',
  code('server/src/lib/callerCheck.js').includes("from './importGraph.js'"));

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nH1 is the incident this repo has actually suffered. "Did this change break a');
  console.log('caller?" is decidable by a script that already exists — it must not rest on a');
  console.log('model\'s judgement, and it must not run only for self-dev.\n');
  process.exit(1);
}
console.log('a change that breaks a caller is caught by a script, on every build turn.\n');
