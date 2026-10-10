#!/usr/bin/env node
/**
 * dev-dock-rig — bring up everything the DOCK needs locally, and nothing else.
 *
 * WHY THIS EXISTS
 *
 * The dock is `public/plugin.js` → `/embed?token=…` → `src/pages/Embed.jsx`,
 * which mounts the SAME tab components as the app's WEBSITE panel, scoped by a
 * widget token instead of a user session. For three sessions it was asserted by
 * source-reading guards only. Nothing in the repo could put it in front of a
 * browser, so "the dock works" was never once observed — see the report in the
 * PR that added this file.
 *
 * WHAT IT DOES
 *
 *   1. ensures server/.env exists (from .env.example) and is usable in dev;
 *   2. reuses the embedded Postgres cluster the repo documents, but in its OWN
 *      database (`morpheus_dock_rig`) so two sessions on one machine cannot
 *      seed, reset or delete each other's rows;
 *   3. starts the mock AI provider (:4599) and mock WordPress (:4600) — no real
 *      model call and no real site can be reached, whatever server/.env says;
 *   4. starts the backend (:4500) and the Vite dev server (:5173);
 *   5. seeds a fixture owner + web-app project + WordPress connection + two
 *      widget tokens through the real server code;
 *   6. prints how to open the dock.
 *
 * `drive` then drives the real thing in a real browser through scripts/pw.
 *
 * Commands
 *   node scripts/dev-dock-rig.mjs up        # start + seed (idempotent)
 *   node scripts/dev-dock-rig.mjs url [full|chat-only]
 *   node scripts/dev-dock-rig.mjs drive     # scripts/pw: render, click, console
 *   node scripts/dev-dock-rig.mjs status
 *   node scripts/dev-dock-rig.mjs logs      # tail what the services are saying
 *   node scripts/dev-dock-rig.mjs down      # stop what this rig started
 *
 * And the one thing the rig can drive that CI cannot: a REAL build.
 *   MOCK_LLM_BUILD=1 node scripts/dev-dock-rig.mjs up
 *   node scripts/rig-build-check.mjs         # drives a build and watches it fan out
 *
 * Overridable: DOCK_RIG_DB, DOCK_RIG_BACKEND_PORT, DOCK_RIG_FRONTEND_PORT,
 * DOCK_RIG_MOCK_LLM_PORT, DOCK_RIG_MOCK_WP_PORT, DOCK_RIG_WP_SECRET.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import crypto from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(REPO, 'server');
const ENV_FILE = join(SERVER, '.env');
const ENV_EXAMPLE = join(SERVER, '.env.example');
const RIG_DIR = join(SERVER, 'data', 'dock-rig');
const STATE_FILE = join(RIG_DIR, 'state.json');

const BACKEND_PORT = Number(process.env.DOCK_RIG_BACKEND_PORT || 4500);
const FRONTEND_PORT = Number(process.env.DOCK_RIG_FRONTEND_PORT || 5173);
const MOCK_LLM_PORT = Number(process.env.DOCK_RIG_MOCK_LLM_PORT || 4599);
const MOCK_WP_PORT = Number(process.env.DOCK_RIG_MOCK_WP_PORT || 4600);
const RIG_DB = process.env.DOCK_RIG_DB || 'morpheus_dock_rig';
const WP_SECRET = process.env.DOCK_RIG_WP_SECRET || 'dock-rig-local-shared-secret';
const SERVICES = ['mock-llm', 'mock-wp', 'backend', 'frontend'];

const log = (m) => console.log(`  ${m}`);
const fail = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };

// ── server/.env ────────────────────────────────────────────────────────────
/**
 * The rig never invents a database or an encryption key per run, but it must
 * not run production config either: crypto.js refuses the placeholder key when
 * NODE_ENV is production, and a dev rig that silently used a real LLM key would
 * spend money. Both are fixed here, in the gitignored file, and said out loud.
 */
function ensureEnvFile() {
  mkdirSync(RIG_DIR, { recursive: true });
  if (!existsSync(ENV_FILE)) {
    if (!existsSync(ENV_EXAMPLE)) fail(`neither ${ENV_FILE} nor ${ENV_EXAMPLE} exists`);
    copyFileSync(ENV_EXAMPLE, ENV_FILE);
    log('created server/.env from server/.env.example (gitignored)');
  }
  let text = readFileSync(ENV_FILE, 'utf8');
  const set = (key, value) => {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) { if (text.match(re)[0] !== line) { text = text.replace(re, line); return true; } return false; }
    text += `${text.endsWith('\n') ? '' : '\n'}${line}\n`;
    return true;
  };
  let changed = false;
  const current = (key) => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/\s+#.*$/, '') : '';
  };
  if (current('NODE_ENV') !== 'development') changed = set('NODE_ENV', 'development') || changed;
  if (!current('ENCRYPTION_KEY') || current('ENCRYPTION_KEY') === 'change-me-32-byte-base64-key') {
    changed = set('ENCRYPTION_KEY', crypto.randomBytes(32).toString('base64')) || changed;
  }
  if (!current('JWT_SECRET') || current('JWT_SECRET') === 'change-me-to-a-long-random-string') {
    changed = set('JWT_SECRET', crypto.randomBytes(32).toString('base64')) || changed;
  }
  if (changed) {
    writeFileSync(ENV_FILE, text);
    log('patched server/.env for local dev (NODE_ENV/ENCRYPTION_KEY/JWT_SECRET)');
  }
}

function loadEnv() {
  process.loadEnvFile(ENV_FILE);
}

function dbParts() {
  const url = String(process.env.DATABASE_URL || '');
  const m = url.match(/^postgresql:\/\/([^:]+):([^@]*)@([^:/]+):(\d+)\/([^?]+)/);
  if (!m) fail(`cannot parse DATABASE_URL in server/.env: ${url}`);
  const [, user, password, host, port, database] = m;
  return { user, password, host, port: Number(port), database, url };
}

const rigUrl = (parts) => `postgresql://${parts.user}:${parts.password}@${parts.host}:${parts.port}/${RIG_DB}?schema=public`;

// ── ports and processes ────────────────────────────────────────────────────
function portOpen(port, host = '127.0.0.1') {
  return new Promise((ok) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); ok(v); };
    s.setTimeout(700);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/**
 * Vite binds `localhost`, which on macOS is ::1 and NOT 127.0.0.1 — so a probe
 * that only tried the IPv4 loopback reported a perfectly healthy dev server as
 * dead. Both families are checked, and anything user-facing uses `localhost`.
 */
async function anyPortOpen(port) {
  if (await portOpen(port, '127.0.0.1')) return true;
  return portOpen(port, '::1');
}

const pidFile = (name) => join(RIG_DIR, `${name}.pid`);
const logFile = (name) => join(RIG_DIR, `${name}.log`);

function readPid(name) {
  try { return Number(readFileSync(pidFile(name), 'utf8').trim()) || null; } catch { return null; }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function running(name) { return alive(readPid(name)); }

function startService(name, command, args, { cwd, env, port }) {
  if (running(name)) { log(`${name}: already running (pid ${readPid(name)})`); return; }
  if (existsSync(pidFile(name))) rmSync(pidFile(name), { force: true });
  const fd = openSync(logFile(name), 'a');
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  writeFileSync(pidFile(name), String(child.pid));
  log(`${name}: started (pid ${child.pid}) → ${logFile(name).replace(REPO + '/', '')}${port ? ` on :${port}` : ''}`);
}

async function waitFor(name, fn, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!running(name)) fail(`${name} exited during startup — see ${logFile(name).replace(REPO + '/', '')}`);
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  fail(`${name} did not become ready in ${timeoutMs / 1000}s — see ${logFile(name).replace(REPO + '/', '')}`);
}

const childEnv = () => ({
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: rigUrl(dbParts()),
  PORT: String(BACKEND_PORT),
  CORS_ORIGIN: `http://localhost:${FRONTEND_PORT}`,
  FRONTEND_URL: `http://localhost:${FRONTEND_PORT}`,
  BACKEND_PUBLIC_URL: `http://localhost:${BACKEND_PORT}`,
  VITE_BACKEND_URL: `http://localhost:${BACKEND_PORT}`,
  // Force the AI at the mock. A rig that could reach a real provider is a rig
  // that spends money and depends on a network; clearing the fallback tiers too
  // means a mock failure shows up as a failure, not as a silent real call.
  LLM_BASE_URL: `http://localhost:${MOCK_LLM_PORT}/v1`,
  LLM_MODEL: 'mock-1',
  LLM_API_KEY: 'dock-rig-mock',
  FALLBACK_LLM_BASE_URL: '',
  FALLBACK_LLM_API_KEY: '',
  MORPHEUS_BROKER_URL: '',
  MORPHEUS_AI_GATEWAY_URL: '',
  MORPHEUS_AI_GATEWAY_TOKEN: '',
  // Background schedules that reach out (npm registry, a model) are noise here.
  FRESHNESS_CHECK_ENABLED: 'false',
  DECK_INSIGHT_ENABLED: 'false',
  DEEPSEEK_BALANCE_CHECK_ENABLED: 'false',
});

// ── database ───────────────────────────────────────────────────────────────
async function ensureDatabase() {
  const parts = dbParts();
  const requireFromServer = createRequire(join(SERVER, 'package.json'));
  const { Client } = requireFromServer('pg');
  const admin = new Client({ host: parts.host, port: parts.port, user: parts.user, password: parts.password, database: 'postgres' });
  await admin.connect().catch((e) => fail(`cannot reach Postgres at ${parts.host}:${parts.port} — ${e.message}\n    Start it with: cd server && npm run dev:db`));
  const res = await admin.query('select 1 from pg_database where datname = $1', [RIG_DB]);
  if (!res.rowCount) {
    // Identifiers cannot be parameterised; RIG_DB is validated below.
    await admin.query(`create database "${RIG_DB}"`);
    log(`created database "${RIG_DB}"`);
  } else {
    log(`database "${RIG_DB}" present`);
  }
  await admin.end().catch(() => {});
}

/**
 * The interlock that stops a typo turning into a dropped column on the dev
 * database a person actually uses: this only ever pushes at a database whose
 * name ends in `_dock_rig`.
 */
function pushSchema() {
  if (!RIG_DB.endsWith('_dock_rig')) {
    fail(`refusing to run prisma db push against "${RIG_DB}" — the rig database name must end in "_dock_rig".`);
  }
  const r = spawnSync(join(SERVER, 'node_modules', '.bin', 'prisma'),
    ['db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: SERVER, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) fail(`prisma db push failed:\n${(r.stderr || r.stdout || '').trim()}`);
  log(`schema pushed to "${RIG_DB}"`);
}

// ── commands ───────────────────────────────────────────────────────────────
async function up() {
  console.log('\nMorpheus dock rig — up\n');
  ensureEnvFile();
  loadEnv();
  const parts = dbParts();
  if (!(await portOpen(parts.port, parts.host))) {
    log(`Postgres is not listening on ${parts.host}:${parts.port} — starting the embedded cluster`);
    const r = spawnSync('npm', ['run', 'dev:db'], { cwd: SERVER, stdio: 'inherit' });
    if (r.status !== 0) fail('`cd server && npm run dev:db` failed — see its output above.');
  } else {
    log(`Postgres already listening on ${parts.host}:${parts.port}`);
  }
  await ensureDatabase();
  pushSchema();

  for (const [name, port] of [['mock-llm', MOCK_LLM_PORT], ['mock-wp', MOCK_WP_PORT], ['backend', BACKEND_PORT], ['frontend', FRONTEND_PORT]]) {
    if (!running(name) && (await anyPortOpen(port))) {
      fail(`port ${port} is already in use by something this rig did not start (${name}).\n    Stop it, or pick another port with DOCK_RIG_${name.toUpperCase().replace('-', '_')}_PORT.`);
    }
  }

  const env = childEnv();
  env.MOCK_WP_SECRET = WP_SECRET;
  startService('mock-llm', process.execPath, [join(REPO, 'scripts', 'dock-rig-mock-llm.mjs')], { cwd: REPO, env, port: MOCK_LLM_PORT });
  startService('mock-wp', process.execPath, [join(REPO, 'scripts', 'dock-rig-mock-wp.mjs')], { cwd: REPO, env, port: MOCK_WP_PORT });
  startService('backend', process.execPath, ['src/index.js'], { cwd: SERVER, env, port: BACKEND_PORT });
  startService('frontend', 'npm', ['run', 'dev', '--', '--port', String(FRONTEND_PORT), '--strictPort'], { cwd: REPO, env, port: FRONTEND_PORT });

  await waitFor('backend', async () => {
    try { return (await fetch(`http://localhost:${BACKEND_PORT}/api/health`)).ok; } catch { return false; }
  });
  await waitFor('frontend', async () => {
    try { return (await fetch(`http://localhost:${FRONTEND_PORT}/`)).ok; } catch { return false; }
  });
  await waitFor('mock-llm', async () => {
    try { return (await fetch(`http://localhost:${MOCK_LLM_PORT}/v1/models`)).ok; } catch { return false; }
  });
  await waitFor('mock-wp', async () => {
    try { return (await fetch(`http://localhost:${MOCK_WP_PORT}/wp-json/morpheus/v1/status`)).ok; } catch { return false; }
  });
  log('backend, frontend and both mocks are up');

  await seed();
  console.log('\n  Ready. Open the dock:');
  console.log(`    node scripts/dev-dock-rig.mjs url            # prints the /embed?token=… URL`);
  console.log(`    node scripts/dev-dock-rig.mjs drive          # drives it with scripts/pw`);
  console.log('    node scripts/dev-dock-rig.mjs down           # stop everything it started\n');
}

async function seed() {
  runSeed();
  console.log('  seeded (node scripts/dock-rig-seed.mjs)');
}

function runSeed() {
  const env = childEnv();
  env.DOCK_RIG_WP_URL = `http://localhost:${MOCK_WP_PORT}`;
  env.DOCK_RIG_WP_SECRET = WP_SECRET;
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'dock-rig-seed.mjs')], { cwd: REPO, env, stdio: 'inherit' });
  if (r.status !== 0) fail('seeding failed — see the output above.');
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function url(which = 'full') {
  const state = readState();
  if (!state) fail('no rig state yet — run `node scripts/dev-dock-rig.mjs up` first.');
  const t = state.tokens[which];
  if (!t) fail(`no token named "${which}" in ${STATE_FILE} (have: ${Object.keys(state.tokens).join(', ')})`);
  console.log(t.embed_url);
}

function status() {
  ensureEnvFile();
  loadEnv();
  const state = readState();
  console.log('\nMorpheus dock rig — status\n');
  for (const [name, port] of [['mock-llm', MOCK_LLM_PORT], ['mock-wp', MOCK_WP_PORT], ['backend', BACKEND_PORT], ['frontend', FRONTEND_PORT]]) {
    const pid = readPid(name);
    console.log(`  ${name.padEnd(9)} :${String(port).padEnd(5)} ${running(name) ? `running (pid ${pid})` : 'stopped'}`);
  }
  console.log(`  database  ${RIG_DB} @ ${dbParts().host}:${dbParts().port}`);
  if (state) {
    console.log(`  seeded    ${state.generated_at} · project "${state.project.name}" [${state.project.compile_target}]`);
    console.log(`  tokens    ${Object.entries(state.tokens).map(([k, v]) => `${k}=${v.prefix}…(${v.scopes.join(',')})`).join('  ')}`);
  } else {
    console.log('  seeded    no — run `up`');
  }
  console.log('');
}

function down() {
  console.log('\nMorpheus dock rig — down\n');
  for (const name of [...SERVICES].reverse()) {
    const pid = readPid(name);
    if (!alive(pid)) { if (pid) rmSync(pidFile(name), { force: true }); log(`${name}: not running`); continue; }
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    rmSync(pidFile(name), { force: true });
    log(`${name}: stopped (pid ${pid})`);
  }
  log('Postgres itself is left running — `cd server && npm run dev:db:stop` stops it.');
  console.log('');
}

function logs() {
  for (const name of SERVICES) {
    const p = logFile(name);
    console.log(`\n── ${name} (${existsSync(p) ? p.replace(REPO + '/', '') : 'no log yet'}) ──`);
    if (existsSync(p)) {
      const lines = readFileSync(p, 'utf8').trim().split('\n');
      console.log(lines.slice(-25).join('\n'));
    }
  }
  console.log('');
}

// ── drive: the real browser, through scripts/pw ─────────────────────────────
// See scripts/dock-rig-drive.sh for the same sequence as a shell script a person
// can read and run step by step.
async function drive() {
  const r = spawnSync('bash', [join(REPO, 'scripts', 'dock-rig-drive.sh')], { cwd: REPO, stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

const commands = { up, down, status, seed, url, logs, drive };
const cmd = process.argv[2] || 'up';
if (!commands[cmd]) {
  console.error(`Unknown command "${cmd}". Use: ${Object.keys(commands).join(' | ')}`);
  process.exit(2);
}
if (cmd === 'up' || cmd === 'status' || cmd === 'seed') mkdirSync(RIG_DIR, { recursive: true });
if (cmd === 'seed') { ensureEnvFile(); loadEnv(); }
try {
  const out = commands[cmd](process.argv[3]);
  if (out && typeof out.then === 'function') await out;
} catch (err) {
  fail(err?.stack || String(err));
}
