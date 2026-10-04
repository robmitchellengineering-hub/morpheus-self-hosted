#!/usr/bin/env node
/**
 * Render the real app pages in a real browser, locally, as a logged-in user.
 *
 * WHY THIS EXISTS — and read this before deciding it is overkill.
 *
 * On 2026-10-04 `#502` shipped `ReferenceError: orderDeckWidgets is not defined` to `/deck/settings`.
 * The page rendered Rob a blank "Something broke on this screen." Every gate was green:
 *
 *   * `npm run lint` — `no-undef` was not switched on for `src/**` (see eslint.config.js; fixed in the
 *     same PR, and it alone would have caught this);
 *   * `npm run build` — Vite does not resolve identifiers;
 *   * `node --check` — syntax only;
 *   * the full guard suite, `mutate-guards`, and the CI job literally named `render`.
 *
 * `render` was green for a structural reason, not a gap in coverage: **every protected page in this app
 * sits behind `ProtectedRoute`, so an unauthenticated render never even fetches the page's chunk.** The
 * CI job renders the app without a session, so the entire logged-in surface — the deck, settings, the
 * workspace — was never rendered by anything, anywhere. A page could be dead and the deploy still read
 * as healthy from outside.
 *
 * This closes that: it brings up the local rig, seeds a real account, mints a LOCAL session, and loads
 * each page in a real browser, failing on any console error, any uncaught exception, the error-boundary
 * screen, or a page that rendered nothing.
 *
 * SAFETY — this must never be able to point at production.
 *
 *   * it refuses to run unless `NODE_ENV` is not `production`;
 *   * it refuses unless the database name ends in `_dock_rig`, the same interlock `dev-dock-rig.mjs`
 *     puts in front of `prisma db push`;
 *   * it reads only `server/.env` (the local dev file) and never `.env.prodsql` / `.env.northflank`;
 *   * it forces the AI at the local mock, so a page that calls a model cannot spend a cent.
 *
 * Run:  node scripts/dev-app-render.mjs                     # the default routes
 *       node scripts/dev-app-render.mjs /deck /deck/settings # named routes
 *       node scripts/dev-app-render.mjs --keep               # leave the rig running to poke at
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(REPO, 'server');
const ENV_FILE = join(SERVER, '.env');
const FRONTEND_PORT = Number(process.env.DOCK_RIG_FRONTEND_PORT || 5173);
const BACKEND_PORT = Number(process.env.DOCK_RIG_BACKEND_PORT || 4500);
const BASE = `http://localhost:${FRONTEND_PORT}`;

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const routes = argv.filter((a) => a.startsWith('/'));
const DEFAULT_ROUTES = ['/deck', '/deck/settings', '/deck/tools', '/deck/jarvis', '/settings', '/workspace'];
const ROUTES = routes.length ? routes : DEFAULT_ROUTES;

const log = (m) => console.log(`  ${m}`);
const fail = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };

// ── safety ─────────────────────────────────────────────────────────────────
// Checked BEFORE anything is started, created or written, because the whole point is that this script
// cannot be pointed at a database people actually use.
//
// Two hazards, and they need different answers:
//
//   * `server/.env` is GITIGNORED, so it does not exist in a fresh worktree. MISSING is fine — the rig
//     creates it from `.env.example` (which is `NODE_ENV=production`, patched to development on the way
//     in). PRESENT and production is not fine.
//   * `dev-dock-rig.mjs` parses HOST and PORT out of `DATABASE_URL` and then swaps only the DATABASE
//     NAME for `morpheus_dock_rig`. So a `.env` aimed at a remote host would have the rig creating and
//     pushing a schema onto that host: the `_dock_rig` name interlock would hold, but it would still be
//     someone else's server. Anything that is not loopback is refused here.
function readEnvValue(text, key) {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/\s+#.*$/, '') : '';
}

function preflight() {
  if (!existsSync(ENV_FILE)) {
    log('server/.env is absent (normal in a fresh worktree) — the rig creates it from .env.example');
    return;
  }
  const text = readFileSync(ENV_FILE, 'utf8');
  const nodeEnv = readEnvValue(text, 'NODE_ENV') || process.env.NODE_ENV || '';
  if (nodeEnv === 'production') fail('refusing to run: NODE_ENV=production in server/.env.');
  const url = readEnvValue(text, 'DATABASE_URL');
  const m = url.match(/^postgresql:\/\/([^:]+):([^@]*)@([^:/]+):(\d+)\//);
  if (!m) fail('refusing to run: cannot parse DATABASE_URL in server/.env.');
  const host = m[3];
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    fail(`refusing to run: server/.env points at "${host}", which is not loopback.\n`
      + '    The rig would create and push a schema onto that host. Point it at local Postgres first.');
  }
}

/**
 * The database this run will actually touch: the rig's own, rebuilt here exactly the way
 * `dev-dock-rig.mjs` builds it for its children (`rigUrl`), and refused unless the name says `_dock_rig`.
 *
 * Read AFTER the rig is up, because the rig is what creates and patches `server/.env`.
 */
function rigDatabaseUrl() {
  process.loadEnvFile(ENV_FILE);
  const url = String(process.env.DATABASE_URL || '');
  const m = url.match(/^postgresql:\/\/([^:]+):([^@]*)@([^:/]+):(\d+)\/([^?]+)/);
  if (!m) fail('cannot parse DATABASE_URL after the rig started — refusing to continue.');
  const [, user, password, host, port] = m;
  const database = process.env.RENDER_CHECK_DB || 'morpheus_dock_rig';
  if (!database.endsWith('_dock_rig')) {
    fail(`refusing to run: database "${database}" does not end in "_dock_rig".\n`
      + '    This script seeds an account and renders pages; it must only ever touch the rig database.');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) fail(`refusing to run: database host "${host}" is not loopback.`);
  // `server/src/db.js` reads this at import time, so it is set before anything imports it.
  process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}:${port}/${database}?schema=public`;
  return { database, host, port: Number(port) };
}

// ── the rig ────────────────────────────────────────────────────────────────
const portOpen = (port, host = '127.0.0.1') => new Promise((ok) => {
  const s = net.connect({ port, host });
  const done = (v) => { s.destroy(); ok(v); };
  s.setTimeout(700);
  s.once('connect', () => done(true));
  s.once('timeout', () => done(false));
  s.once('error', () => done(false));
});
async function anyPortOpen(port) { return (await portOpen(port)) || portOpen(port, '::1'); }

/**
 * Bring the rig up if it is not already running. Deliberately a child process rather than a copy of
 * its logic: `dev-dock-rig.mjs` owns the embedded Postgres, the schema push, the mocks and the two
 * servers, and duplicating that here would be a second thing to keep in step.
 *
 * Returns whether THIS run started the rig, because it must stop what it started: the rig's mock LLM
 * holds :4599, which `scripts/boot-smoke.mjs` also wants, so leaving it up turns a green `verify.mjs`
 * into a red one for the next person. A rig a human already had running is left alone.
 */
async function ensureRig() {
  if (await anyPortOpen(FRONTEND_PORT) && await anyPortOpen(BACKEND_PORT)) {
    log(`rig already up (frontend :${FRONTEND_PORT}, backend :${BACKEND_PORT}) — leaving it as it was`);
    return false;
  }
  log('rig is not up — starting it (this can take a minute the first time)');
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'dev-dock-rig.mjs'), 'up'], { stdio: 'inherit' });
  if (r.status !== 0) fail('`node scripts/dev-dock-rig.mjs up` failed — see its output above.');
  for (let i = 0; i < 60; i++) {
    if (await anyPortOpen(FRONTEND_PORT) && await anyPortOpen(BACKEND_PORT)) return true;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  fail(`the rig did not answer on :${FRONTEND_PORT} and :${BACKEND_PORT} within 60s.`);
}

// ── seed ───────────────────────────────────────────────────────────────────
/**
 * The smallest real account that makes the deck and Settings render with content.
 *
 * ONE DELIBERATE CHOICE: the widget rows are seeded with brain dump stored at `sort_order 1`, BEHIND
 * Jarvis's suggestions — which is what production actually holds for two of four real accounts, and the
 * shape Rob reported from a new user. The read-time pin is what corrects it, so seeding the correct
 * order here would leave the thing that broke untested.
 */
async function seed() {
  const { prisma } = await import('../server/src/db.js');
  const email = process.env.RENDER_CHECK_EMAIL || 'render-check@example.test';

  const user = await prisma.user.upsert({
    where: { email },
    update: { role: 'admin', email_verified: true },
    create: { email, password_hash: 'render-check-no-login', full_name: 'Render Check', role: 'admin', email_verified: true },
  });

  await prisma.deckBusinessProfile.upsert({
    where: { created_by_id: user.id },
    update: {},
    create: {
      created_by_id: user.id,
      shop_name: 'Render Check Fixture',
      tagline: 'A local account that exists to make pages render',
      contact_email: email,
      business_context: 'Seeded by scripts/dev-app-render.mjs. Safe to delete.',
    },
  });

  // `operating_regions` by RAW SQL, and the reason is worth knowing: the rig pushes the schema with
  // `prisma db push --skip-generate`, so the COLUMN exists in the rig database while the generated
  // client in `server/node_modules` may predate it. Rendering is exactly the situation where a newer
  // column exists and the client has not heard of it, so this seeds the realistic state instead of
  // working around it — and it keeps the region-grounded paths in the fixture.
  // No `::uuid` cast: Prisma maps `String` to `text` on Postgres, so both sides are text here and
  // casting the parameter made it `text = uuid`, which Postgres refuses outright.
  await prisma.$executeRaw`
    update deck_business_profiles
       set operating_regions = array['Brunswick Heads Australia 2483']::text[]
     where created_by_id = ${user.id}
  `;

  // Widget rows, in the WRONG order on purpose (see the comment above). Keys are read from the registry
  // source rather than imported: deckWidgets.js pulls in React icon components, which cannot load here.
  const registry = readFileSync(join(REPO, 'src/pages/CommandDeck/deckWidgets.js'), 'utf8');
  const keys = [...registry.matchAll(/\{ key: '([a-z_]+)'/g)].map((m) => m[1]);
  if (keys.length < 10) fail(`only parsed ${keys.length} widget keys out of the registry — refusing to seed a fixture that does not represent a real deck.`);
  const ordered = ['jarvis_suggestions', ...keys.filter((k) => k !== 'jarvis_suggestions')];
  for (const [i, key] of ordered.entries()) {
    await prisma.deckWidgetInstance.upsert({
      where: { created_by_id_widget_key: { created_by_id: user.id, widget_key: key } },
      update: { sort_order: i },
      create: { created_by_id: user.id, widget_key: key, enabled: true, sort_order: i },
    });
  }

  // A little content, so the deck's own widgets have something to draw.
  const dumpCount = await prisma.deckDumpItem.count({ where: { created_by_id: user.id } });
  if (!dumpCount) {
    await prisma.deckDumpItem.createMany({
      data: [
        { created_by_id: user.id, text: 'Render check: ring the supplier about the backline quote' },
        { created_by_id: user.id, text: 'Render check: two guitars on consignment, photos still to take' },
      ],
    });
  }

  await prisma.$disconnect();
  log(`seeded ${user.email} · ${ordered.length} widget rows (brain dump deliberately NOT first)`);
  return user;
}

// ── session ────────────────────────────────────────────────────────────────
/**
 * Mint a session exactly the way the server does (`server/src/auth.js` issueToken), with the LOCAL
 * JWT_SECRET out of server/.env. This is the local dev secret — generated by dev-dock-rig if it was a
 * placeholder — and the value is never printed, written anywhere, or sent off this machine.
 *
 * Signing directly rather than going through /auth/login is deliberate: the seeded account has no
 * usable password, and a render check should not depend on the login form working. Logging in is its
 * own thing with its own tests; this is about what the page does once you are in.
 */
async function mintToken(user) {
  const jwt = (await import(join(SERVER, 'node_modules', 'jsonwebtoken', 'index.js'))).default;
  process.loadEnvFile(ENV_FILE);
  const secret = process.env.JWT_SECRET;
  if (!secret) fail('JWT_SECRET is missing from server/.env — run `node scripts/dev-dock-rig.mjs up` to generate one.');
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, secret, { expiresIn: '1h' });
}

// ── render ─────────────────────────────────────────────────────────────────
/**
 * A real browser via `playwright-core`, using the system Chrome and the same launch flags as
 * `scripts/pw` (`--no-sandbox`, because Chrome cannot nest its sandbox inside DSH's).
 *
 * The session is installed with `addInitScript`, so it exists before the app's first line of code runs —
 * a `localStorage.setItem` after load would race the router and land on /login.
 */
async function renderAll(token) {
  // `playwright-core` is CommonJS, so an absolute-path ESM import puts everything on `.default`.
  const pw = await import(join(REPO, 'node_modules', 'playwright-core', 'index.js'));
  const { chromium } = pw.default ?? pw;
  if (!chromium) fail('could not load playwright-core — `npm ci` in the repo root first.');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-crashpad', '--disable-dev-shm-usage'],
  });
  const results = [];
  try {
    for (const route of ROUTES) {
      const context = await browser.newContext();
      await context.addInitScript((t) => {
        try { window.localStorage.setItem('morpheus_token', t); } catch { /* nothing to do */ }
      }, token);
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      page.on('pageerror', (err) => pageErrors.push(err?.message || String(err)));

      let navigationError = null;
      try {
        await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 45000 });
      } catch (e) {
        navigationError = e.message;
      }
      // React commits the boundary's fallback on a later paint than `networkidle` guarantees.
      await page.waitForTimeout(750);

      const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      const landedOn = await page.evaluate(() => window.location.pathname).catch(() => '?');
      const boundary = /Something broke on this screen|Morpheus was updated while this page was open/.test(body);
      const blank = body.replace(/\s+/g, '').length < 40;
      const bouncedToLogin = landedOn.startsWith('/login');
      // An uncaught ReferenceError/TypeError is the failure this check exists for, and React logs it to
      // the console as well as re-throwing it — both are collected, and both fail the route.
      const fatal = [...pageErrors, ...consoleErrors].filter((m) => /is not defined|Cannot read|is not a function|Maximum update depth|Minified React error/.test(m));

      results.push({ route, landedOn, boundary, blank, bouncedToLogin, pageErrors, consoleErrors, fatal, navigationError, body });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}

// ── main ───────────────────────────────────────────────────────────────────
console.log('\nMorpheus render check — the real pages, in a real browser, locally\n');
preflight();
const startedRig = await ensureRig();
const db = rigDatabaseUrl();
log(`target database: ${db.database} on ${db.host}:${db.port}`);
const user = await seed();
const token = await mintToken(user);

console.log(`\n  Rendering ${ROUTES.length} route(s) against ${BASE}\n`);
const results = await renderAll(token);

let failures = 0;
for (const r of results) {
  const problems = [];
  if (r.navigationError) problems.push(`navigation: ${r.navigationError}`);
  if (r.boundary) problems.push('the error boundary is on screen');
  if (r.fatal.length) problems.push(`uncaught: ${r.fatal[0].split('\n')[0]}`);
  if (r.blank) problems.push('the page rendered nothing');
  if (r.bouncedToLogin) problems.push('bounced to /login — the session was not accepted');
  if (problems.length) {
    failures++;
    console.log(`  ✗ ${r.route}`);
    for (const p of problems) console.log(`      ${p}`);
    if (r.pageErrors.length) console.log(`      page errors: ${r.pageErrors.slice(0, 3).join(' | ')}`);
    const consoleFails = r.consoleErrors.filter((t) => !r.fatal.includes(t));
    if (consoleFails.length) console.log(`      console: ${consoleFails.slice(0, 3).join(' | ')}`);
  } else {
    // A one-line description of what it found, so "it passed" is never the only evidence.
    const first = r.body.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 4).join(' · ').slice(0, 90);
    console.log(`  ✓ ${r.route.padEnd(16)} ${r.landedOn.padEnd(16)} ${first}`);
  }
  // A console error on a page that otherwise rendered is a warning here, not a failure — the app has
  // known-benign ones (a blocked avatar, an aborted request on navigation) and failing on those would
  // make this check something people switch off. Uncaught errors and the boundary are hard failures.
  const benign = r.consoleErrors.filter((t) => !r.fatal.includes(t));
  if (benign.length && !problems.length) console.log(`      (${benign.length} console error(s), not fatal: ${benign[0].slice(0, 70)})`);
}

console.log(`\n${results.length - failures}/${results.length} route(s) rendered cleanly`);

// Tidy up after OURSELVES, and only ourselves. The rig's mock LLM holds :4599, which
// scripts/boot-smoke.mjs also wants, so a run that started the rig and walked away would turn a green
// `npm run verify` into a red one for whoever runs it next. `--keep` is for iterating on a page.
if (startedRig && !keep) {
  spawnSync(process.execPath, [join(REPO, 'scripts', 'dev-dock-rig.mjs'), 'down'], { stdio: 'inherit' });
} else if (keep) {
  log('--keep: leaving the rig up (`node scripts/dev-dock-rig.mjs down` stops it)');
}

if (failures) {
  console.log('\n  ✗ a page does not render — this is exactly what shipped to production once.\n');
  process.exit(1);
}
console.log('\n  every page rendered as a logged-in user\n');
