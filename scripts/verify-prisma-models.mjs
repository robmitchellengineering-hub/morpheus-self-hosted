// Every `prisma.<delegate>` the server uses must be a model that exists.
//
// WHY THIS EXISTS
//
// Self-dev generated an admin endpoint that counted self-dev runs with
// `prisma.selfDevRun.count()`. There is no such model — that table is added by a
// manual migration and read with raw SQL (lib/selfDevRuns.js) — so the expression
// threw while the Promise.allSettled array was still being built, and every request
// to the endpoint failed.
//
// It passed lint, `npm run build`, all 35 guards and the render check. Nothing in
// the pipeline ever asks whether the Prisma delegate a file names actually exists:
// Prisma's client only fails at RUNTIME, on the request that reaches it. That is
// hazard H15 — a behaviour loss that passes every gate — and it is exactly the kind
// of thing a gate is supposed to catch, because the answer is knowable statically
// from schema.prisma.
//
// Prisma's delegate for `model User` is `prisma.user`: first letter lowercased.
// This is asserted against a worked example below, because a silent change to that
// derivation would make this guard pass everything.
//
// Dependency-free on purpose — it runs in CI's no-install guards job (hazard H4).
//
// Run:  node scripts/verify-prisma-models.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const problems = [];

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    if (detail) console.log(`          ${detail}`);
    problems.push(name);
  }
  ok ? pass++ : fail++;
}

/** Model name -> Prisma client delegate name. `User` -> `user`, `DeckWidget` -> `deckWidget`. */
export const delegateFor = (model) => model[0].toLowerCase() + model.slice(1);

/**
 * The Prisma client's own members — everything after `prisma.` that is not a model.
 * Listed explicitly rather than matched by a leading `$`, so a new model named
 * without a leading `$` cannot be waved through as "probably a client method".
 */
const CLIENT_MEMBERS = new Set([
  '$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe',
  '$transaction', '$connect', '$disconnect', '$on', '$extends', '$use',
]);

/** Every .js file under a directory, recursively. */
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

// Comments are stripped, but only whole-line `//` comments and `/* */` blocks. A
// trailing `//` strip would corrupt any line containing a URL, and a false negative
// here is the one failure mode that matters: it would hide a real unknown delegate.
function maskComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const schema = readFileSync(join(REPO, 'server/prisma/schema.prisma'), 'utf8');
const models = [...schema.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{/gm)].map((m) => m[1]);
const delegates = new Set(models.map(delegateFor));

console.log('\nPrisma delegates — every prisma.<name> must be a model that exists\n');

// ── the parser sanity checks ────────────────────────────────────────────────
// A regex that stops matching would make every assertion below vacuously true.
check('the schema was parsed and has models', models.length >= 40, `found ${models.length}`);
check('the delegate derivation is the one Prisma documents',
  delegateFor('User') === 'user' && delegateFor('DeckWidget') === 'deckWidget' && delegateFor('UsageRecord') === 'usageRecord',
  `User->${delegateFor('User')}, DeckWidget->${delegateFor('DeckWidget')}`);
check('every model yields a distinct delegate', delegates.size === models.length,
  `${models.length} models, ${delegates.size} delegates`);

// ── the real check ──────────────────────────────────────────────────────────
const unknown = new Map();
let examined = 0;
for (const file of walk(join(REPO, 'server/src'))) {
  const src = maskComments(readFileSync(file, 'utf8'));
  for (const m of src.matchAll(/prisma\.([A-Za-z_$][\w$]*)/g)) {
    examined++;
    const name = m[1];
    if (delegates.has(name) || CLIENT_MEMBERS.has(name)) continue;
    if (!unknown.has(name)) unknown.set(name, new Set());
    unknown.get(name).add(relative(REPO, file));
  }
}

// If the scanner reached nothing it would report a clean tree — the exact "a check
// that examined nothing reports a pass" failure this repo has hit before.
check('the scanner actually read the server tree', examined >= 200, `examined ${examined} prisma.<name> reference(s)`);

for (const [name, files] of unknown) {
  console.log(`  FAIL  prisma.${name} is not a model in schema.prisma`);
  console.log(`          ${[...files].join('\n          ')}`);
  problems.push(`prisma.${name}`);
  fail++;
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nPrisma only fails at runtime, on the request that reaches it — which is why this');
  console.log('is checked here instead. Either the model is missing from schema.prisma, or the');
  console.log('table is a raw-SQL one and the file should use lib/selfDevRuns.js-style access.\n');
  process.exit(1);
}
console.log('every prisma delegate resolves to a model.\n');
