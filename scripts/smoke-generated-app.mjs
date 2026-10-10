// Does a self-contained app we ship actually start and answer a request on this machine?
//
// WHY THIS EXISTS. Everything else in this repo checks the code that WRITES an app. On 2026-09-29 a
// generated self-contained backend was checked that way too — and then run, for the first time, and it
// failed twice before answering anything: a dependency with no prebuilt binary for this Node, and a
// module contract that could not hold. Neither is visible from reading the generator. `verify.mjs`'s own
// suite has said "nothing runs the code" about the build pipeline for days; this is that gap, pointed at
// the artefact the operator actually receives.
//
// WHAT IT RUNS. `server/test-fixtures/runnable-app` — a real, minimal, self-contained app in the shape the
// generator is asked to produce: one `npm start`, a local database created on first run, a schema applied
// at boot, one route that touches the database. It is a FIXTURE, not generated output, deliberately: a
// guard that called the AI would need a key, cost credits, and be non-deterministic, so it could not run
// on every PR. What the fixture proves is that the SHAPE works end to end; `verify-generated-app.mjs`
// checks generated output against the same shape without running it, and carries the two defects that
// were measured.
//
// IT INSTALLS. That is the point — a pre-installed fixture would prove nothing about the first command in
// the README, which is the promise under test. If the network is unavailable it says so and exits 2
// rather than failing the build, matching how verify-schema-prod.mjs reports a missing credential.
//
// Run:  node scripts/smoke-generated-app.mjs
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generatedAppProblems, RUNNABLE_APP_REQUIREMENTS, packageJsonOf } from '../server/src/lib/generatedAppCheck.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'server', 'test-fixtures', 'runnable-app');
const PORT = process.env.SMOKE_APP_PORT || '3011';
const BASE = `http://127.0.0.1:${PORT}`;
const INSTALL_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 30_000;

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(join(dir, e.name));
  return [join(dir, e.name)];
});
const fixtureFiles = () => walk(FIXTURE).map((p) => ({ path: relative(FIXTURE, p), content: readFileSync(p, 'utf8') }));

console.log('\n1. the fixture is the shape we ask the generator for');
const files = fixtureFiles();
check('the source-level checker accepts it', generatedAppProblems(files), []);
check('…and every runnable-app requirement holds', RUNNABLE_APP_REQUIREMENTS.every((r) => r.verify(files, packageJsonOf(files))), true);

// Work on a copy so an interrupted run cannot leave a node_modules or a database inside the repo, and so
// the fixture in git stays exactly what is reviewed.
const work = mkdtempSync(join(tmpdir(), 'morpheus-smoke-app-'));
let child = null;
const cleanup = () => {
  try { if (child) child.kill('SIGKILL'); } catch { /* already gone */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', cleanup);

// ── the browser pass, OPT-IN (`--render`) ────────────────────────────────────────────────────────────────────
//
// ⚠️ WHY IT IS OPT-IN AND NOT PART OF THE DEFAULT RUN. This script already runs inside the REQUIRED `render` job,
// so adding these assertions unconditionally would have made a browser check gate every self-dev merge
// immediately — the failure mode the 2026-09-23 plan warns about in its first line ("a flaky required gate blocks
// every merge"). It lands ADVISORY: a real job on the PR, absent from `SELF_DEV_REQUIRED_CHECKS`, promoted only
// after it has run clean across several real PRs. Promotion is one array entry, and `verify-merge-gates.mjs`
// keeps the two lists from drifting.
//
// So the default run is byte-for-byte what it was, and `--render` adds the tier.
async function checkRenderedPage() {

    //
    // Everything above is HTTP, and this repo spent a day learning why that is not enough: a bundle check passes
    // and an HTTP 200 says only that a shell was served, while the page is blank or the console is throwing — a
    // dock panel off the bottom of the screen, a guided link 404ing inside the app's own router, both of them
    // green (MORPHEUS-BIG-PICTURE.md, "Self-dev should render what it builds"). So: a real browser, a VISIBLE
    // heading, the row the API just created actually on screen, a clean console, nothing thrown.
    //
    // `playwright-core` against the runner's own Chrome, exactly as scripts/render-smoke.mjs does it — that
    // mechanism is already carrying the required `render` job, so this reuses it rather than inventing a second
    // way to obtain a browser.
    const { chromium } = await import('playwright-core');
    const channel = process.env.RENDER_SMOKE_CHANNEL || 'chrome';
    const executablePath = process.env.RENDER_SMOKE_BROWSER || undefined;
    let browser;
    try {
      browser = await chromium.launch({
        channel: executablePath ? undefined : channel,
        executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-crashpad'],
      });
    } catch (browserErr) {
      // A machine with no browser is NOT an app that fails to render. Exit 2, "cannot check", the same as an
      // unreachable registry above — a check that could not run must never read as one that passed (H17).
      console.log(`\n  ⚠  no browser available (channel "${channel}"): ${browserErr.message.split('\n')[0]}`);
      console.log('     The app was NOT rendered. This is not a pass.');
      console.log('     Set RENDER_SMOKE_BROWSER=/path/to/chrome, or run `npx playwright install chrome`.\n');
      console.log('  0/0 checks passed — NOT VERIFIED\n');
      process.exit(2);
    }

    console.log('\n5. and the page a person sees actually renders');
    try {
      const page = await browser.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      // The same allowlist the required `render` job uses — Chrome's own noise (an unprompted favicon request, the
      // Vite banner, the React DevTools notice) is not the app's fault.
      const BENIGN_CONSOLE = [/favicon/i, /\[vite\]/i, /Download the React DevTools/i];
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (BENIGN_CONSOLE.some((re) => re.test(text))) return;
        consoleErrors.push(text);
      });
      page.on('pageerror', (e) => pageErrors.push(e?.stack || String(e)));
      // ⚠️ AND KEEP THE RESPONSE SIDE. Chrome's console message for a missing asset does not always name the URL,
      // so filtering the message alone would hide a genuinely broken same-origin asset. `render-smoke.mjs` keeps
      // both for the same reason, and copying only the allowlist would have been the weaker half.
      const badResponses = [];
      page.on('response', (res) => {
        if (res.status() >= 400 && res.url().startsWith(BASE)) badResponses.push(`${res.status()} ${res.url().replace(BASE, '')}`);
      });

      const response = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      check('GET / answers with a page', response?.status(), 200);
      check('…and it is served as HTML, not JSON', /text\/html/.test(response?.headers()['content-type'] || ''), true);
      // VISIBLE, not merely present in the DOM. Content that exists and cannot be seen is the exact failure this
      // tier was added for, and `isVisible()` is what distinguishes the two.
      check('…the heading is VISIBLE', await page.locator('[data-page="fixture-home"]').isVisible(), true);
      check('…the row the API created is on the screen', (await page.locator('[data-task]').first().textContent())?.trim(), 'smoke');
      check('…and the count agrees with it', (await page.locator('[data-count]').textContent())?.trim(), '1 task(s)');
      check('nothing threw in the browser', pageErrors, []);
      check('no same-origin asset 404s or 500s', badResponses, []);
      check('the console is clean', consoleErrors, []);
    } finally {
      await browser.close();
    }
}

try {
  cpSync(FIXTURE, work, { recursive: true });

  console.log('\n2. the one command in its README installs it');
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: work, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS,
  });
  const installOut = `${install.stdout || ''}${install.stderr || ''}`;
  // A registry that cannot be reached is not a defect in the app, and must not fail the build. Reported
  // loudly as NOT VERIFIED, never as a pass.
  if (install.status !== 0 && /ENOTFOUND|EAI_AGAIN|network|ECONNREFUSED|registry\.npmjs\.org/i.test(installOut) && !existsSync(join(work, 'node_modules'))) {
    console.log(`\n  ⚠  npm install could not reach the registry — the app was NOT run.`);
    console.log('     This is not a pass.\n');
    console.log('  0/0 checks passed — NOT VERIFIED\n');
    process.exit(2);
  }
  check('npm install succeeds', install.status, 0);
  if (install.status !== 0) {
    console.log(`\n  install output (tail):\n${installOut.split('\n').slice(-12).join('\n')}\n`);
    throw new Error('install failed');
  }
  check('…and no package needed a source compile', /node-gyp|gyp ERR!/i.test(installOut), false);

  console.log('\n3. it starts, creates its own database, and answers');
  const dbPath = join(work, 'data', 'smoke.db');
  check('…no database exists before the first run', existsSync(dbPath), false);

  // Node directly, not `npm start`. Both run the same command — the fixture's start script IS
  // `node server/index.js` — but npm spawns the server as a GRANDCHILD, so killing npm leaves an orphan
  // holding the port. That is not hypothetical: the first version did exactly that and left a server
  // running after the suite reported success. The start script is read from the manifest so this stays
  // honest about what `npm start` would do.
  const startScript = packageJsonOf(files)?.data?.scripts?.start;
  const startTarget = /(?:^|\s)([^\s'"]+\.(?:js|mjs|cjs))/.exec(String(startScript))?.[1];
  check('the start script names a file to run directly', Boolean(startTarget), true);
  child = spawn(process.execPath, [startTarget], {
    cwd: work,
    env: { ...process.env, PORT, DATABASE_URL: dbPath, JWT_SECRET: 'smoke-test-only' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let health = null;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) { health = await res.json(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  check('the server answers /api/health', Boolean(health?.ok), true);
  if (!health) {
    console.log(`\n  stdout:\n${out.split('\n').slice(-10).join('\n')}`);
    console.log(`\n  stderr:\n${err.split('\n').slice(-10).join('\n')}\n`);
    throw new Error('the app never became healthy');
  }
  check('…and it created its database itself, with no setup step', existsSync(dbPath), true);
  check('…having applied its schema on boot, not asked the operator to', /listening on/.test(out), true);
  check('…as a direct child, so cleanup cannot orphan it', Boolean(child.pid), true);

  console.log('\n4. the route that touches the database works — the defect that shipped');
  // Read as text first. An Express error page is HTML, and `r.json()` on it throws the useless
  // "Unexpected token '<'", which is how the first negative test reported a real defect: true, but
  // undiagnosable. The status and the body are what say WHICH route broke and how.
  const getJson = async (path) => {
    const res = await fetch(`${BASE}${path}`);
    const body = await res.text();
    try { return JSON.parse(body); } catch {
      throw new Error(`GET ${path} returned ${res.status} ${res.headers.get('content-type') || ''} instead of JSON — the route threw. Body: ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  };
  const empty = await getJson('/api/tasks');
  check('GET /api/tasks returns the declared shape', Object.keys(empty).join(','), 'tasks');
  const created = await fetch(`${BASE}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'smoke' }),
  });
  check('POST /api/tasks accepts a row', created.status, 201);
  const after = await getJson('/api/tasks');
  check('…and it is readable back', after.tasks.map((t) => t.title), ['smoke']);
  // The exact failure on 2026-09-29 was a TypeError on the first request, so stderr must be clean.
  check('nothing threw while serving', /TypeError|is not a function/.test(err), false);

  // The page a person sees — only under `--render`. See checkRenderedPage above for why it is opt-in.
  if (process.argv.includes('--render')) await checkRenderedPage();
} catch (error) {
  if (!failures) { console.log(`\n  ✗ ${error.message}\n`); failures++; checks++; }
} finally {
  cleanup();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a self-contained app did not run on this machine\n');
  process.exit(1);
}
console.log('a self-contained app installs with no compiler, starts on one command, and answers a request\n');
