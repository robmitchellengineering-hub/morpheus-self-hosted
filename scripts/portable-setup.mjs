// Portable Morpheus — one command from "I unzipped this" to "the server is running on this machine".
//
//   node scripts/portable-setup.mjs            # do it
//   node scripts/portable-setup.mjs --check    # print the plan and what is missing, change nothing
//
// WHAT THIS IS NOT: a second way to run a database. `server/scripts/dev-db.mjs` already drives real
// Postgres binaries with initdb/pg_ctl (see its header for why not the library's class, which stops
// Postgres when the process exits). This script generates what a person cannot be asked to invent —
// the three secrets — and then DELEGATES the database work to that script. If it goes missing, this
// fails loudly rather than growing a replacement.
//
// The steps and every word about what is still missing live in server/src/lib/portableSetup.js, so the
// guard in CI's no-install job can assert them without running any of this.
//
// Run:  node scripts/portable-setup.mjs [--check] [--skip-install] [--skip-build] [--yes]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTALL_STEPS, NOT_INSTALLED_YET, GENERATED_ENV, preflight, generateSecrets, envFileContents,
  localUrl, REQUIRED_NODE_MAJOR,
} from '../server/src/lib/portableSetup.js';
import { PORTABLE_GATEKEEPER_NOTE, launcherFor } from '../server/src/lib/portableLaunch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server');
const ENV_PATH = join(SERVER, '.env');
const DEV_DB = join(SERVER, 'scripts', 'dev-db.mjs');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const SKIP_INSTALL = argv.includes('--skip-install');
const SKIP_BUILD = argv.includes('--skip-build');

const say = (s) => console.log(s);
const step = (n, s) => console.log(`\n  [${n}/${INSTALL_STEPS.length}] ${s}`);
function run(cmd, args, cwd) {
  // stdio inherited: this is an installer, and hiding npm's or initdb's output makes a failure
  // impossible for the operator to act on.
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n  ✗ "${cmd} ${args.join(' ')}" failed (exit ${r.status}). Nothing further was attempted.`);
    process.exit(1);
  }
}

say('\n  PORTABLE MORPHEUS — local setup');
say(`  This installs and starts the server on this machine. URL when done: ${localUrl()}`);

// ── preflight ───────────────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split('.')[0]);
const pf = preflight({ nodeMajor, platform: process.platform });
if (!pf.ok) {
  console.error('');
  for (const p of pf.problems) console.error(`  ✗ ${p}`);
  console.error('\n  Nothing was changed.\n');
  process.exit(2);
}
say(`  Node ${process.versions.node} · ${process.platform}`);

if (CHECK) {
  say('\n  PLAN (nothing will be written):');
  INSTALL_STEPS.forEach((s, i) => say(`    ${i + 1}. ${s.title}`));
  say('\n  SECRETS this install will generate for itself (values are never printed):');
  for (const g of GENERATED_ENV) say(`    · ${g.key} — ${g.how}`);
  say(`\n  server/.env: ${existsSync(ENV_PATH) ? 'already exists — it will be LEFT ALONE' : 'will be created'}`);
  say('\n  NOT INCLUDED YET:');
  for (const n of NOT_INSTALLED_YET) say(`    · ${n}`);
  say('\n  Re-run without --check to do it.\n');
  process.exit(0);
}

// ── 1. env ──────────────────────────────────────────────────────────────────
step(1, INSTALL_STEPS[0].title);
step(2, INSTALL_STEPS[1].title);
if (existsSync(ENV_PATH)) {
  // Never overwrite: it holds this install's encryption key, and rotating that silently would make
  // every stored connection credential undecryptable.
  say('      server/.env already exists — leaving it untouched.');
} else {
  const secrets = generateSecrets(randomBytes);
  writeFileSync(ENV_PATH, envFileContents({ secrets }), { mode: 0o600 });
  say('      wrote server/.env (mode 600) with generated secrets — not printed here.');
}

// ── 2. dependencies ─────────────────────────────────────────────────────────
step(3, INSTALL_STEPS[2].title);
if (SKIP_INSTALL) {
  say('      skipped (--skip-install)');
} else {
  run('npm', ['install', '--no-audit', '--no-fund'], ROOT);
  run('npm', ['install', '--no-audit', '--no-fund'], SERVER);
}

// ── 3. the local database, through the script that already owns this ────────
step(4, INSTALL_STEPS[3].title);
if (!existsSync(DEV_DB)) {
  console.error(`\n  ✗ ${DEV_DB} is missing. This installer delegates to it rather than starting a`);
  console.error('    database of its own — a second mechanism is how the portable download ended up');
  console.error('    shipping a tree a month out of date. Restore it and re-run.\n');
  process.exit(1);
}
run(process.execPath, [DEV_DB, 'start'], SERVER);

// ── 4. schema ───────────────────────────────────────────────────────────────
step(5, INSTALL_STEPS[4].title);
run(process.execPath, [DEV_DB, 'schema'], SERVER);

// ── 5. frontend ─────────────────────────────────────────────────────────────
step(6, INSTALL_STEPS[5].title);
if (SKIP_BUILD) {
  say('      skipped (--skip-build)');
} else {
  // Built WITHOUT VITE_API_BASE_URL on purpose: the default is same-origin `/api`, and the server
  // serves this dist/ itself (server/src/index.js), so there is no second process and no CORS origin
  // to configure.
  run('npm', ['run', 'build'], ROOT);
}

say('\n  DONE.\n');
say('  After this, you do not need a terminal vocabulary:');
say('    - double-click the launcher for this platform (see below), or');
say('    - npm run portable:start   (and npm run portable:stop to stop)');
say(`    ${PORTABLE_GATEKEEPER_NOTE}`);
say('');
say(`  Start it:      cd server && npm start`);
say(`  Then open:     ${localUrl()}`);
say(`  Launcher:      ${launcherFor(process.platform)?.file || '(none for this platform — use the npm command)'}`);
say('');
say('  NOT INCLUDED YET:');
for (const n of NOT_INSTALLED_YET) say(`    · ${n}`);
say('');
say('  That list is generated from server/src/lib/portableSetup.js — the same list the guard');
say('  asserts, so it cannot quietly go stale.');
say('');
