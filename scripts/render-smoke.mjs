// DOES THE APP ACTUALLY RENDER? A real browser against the BUILT app.
//
// WHY THIS EXISTS
//
// Self-dev verifies twice and NEITHER tier renders anything:
//
//   * engine/verify.js parses, bundles and checks exports with esbuild — it
//     never mounts a component.
//   * smokeCheckSelfDev probes live URLs over HTTP, and an SPA answers 200 for
//     every path (see the verification card, "An SPA answers 200 for every
//     path"), so an HTTP 200 says only that index.html was served.
//
// In one day this repo shipped a dock panel that opened OFF THE BOTTOM of the
// screen, and a guided link that 404'd INSIDE the app's own router. Both passed
// a bundle check AND an HTTP 200. A build that succeeds, and a route that
// answers 200, are not evidence that the page a person sees rendered.
//
// So this checks the one thing neither existing tier can. It serves dist/ (the
// BUILT output), opens each public route in real Chrome, and asserts that the
// route reached its destination and rendered a locator NAMING that page — with
// a clean console and no unhandled page error. On failure it writes a
// screenshot to a directory CI uploads, plus a JSON report naming the routes.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
//   * No backend, no database, no server/. /api/* is answered by a stub on the
//     SAME ORIGIN whose data is EMPTY on purpose: this asserts the app renders
//     on its own, and that an empty API degrades to an empty state rather than
//     a blank page or a thrown error.
//   * Nothing outside this origin is reached. Third-party XHR gets `{}`, other
//     third-party requests get an empty body — a browser check that reaches a
//     live third party passes or fails on the weather.
//   * It does not drive interactions. This is a floor, not a ceiling: "the
//     route renders and does not throw in a browser". Interaction, layout and
//     cross-route flows are richer tests this does not replace.
//
// ADVISORY. Not in SELF_DEV_REQUIRED_CHECKS, and not blocking a merge while it
// earns its reliability. Promotion is one array entry in
// server/src/lib/engine/requiredChecks.js — deliberately, and only after it has
// run clean across several real pull requests.
//
// Run:  npm run build && node scripts/render-smoke.mjs
//       node scripts/render-smoke.mjs --out=.render-smoke --route-timeout=25000
//
// Exit: 0 every route rendered · 1 a route failed to render (see the report)

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'dist');

// ── options ─────────────────────────────────────────────────────────────────
const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const OUT_DIR = resolve(REPO, String(arg('out', '.render-smoke')));
// The route's own locator must appear inside this long. CI's runner is slower
// than a laptop (and the Landing page types its boot line out on a timer,
// ~2.5s, before its guided buttons exist at all), so the default is generous
// rather than tight — a tight timeout is how a render check becomes a flaky
// render check.
const ROUTE_TIMEOUT_MS = Number(arg('route-timeout', 25000));
const NAV_TIMEOUT_MS = Number(arg('nav-timeout', 15000));
// The browser is BROUGHT, never assumed: `channel: 'chrome'` uses the Chrome
// the runner already has, so no download step can make this slow or flaky.
// Override with RENDER_SMOKE_BROWSER=/path/to/chrome (useful off CI).
const CHROME_CHANNEL = process.env.RENDER_SMOKE_CHANNEL || 'chrome';
const CHROME_PATH = process.env.RENDER_SMOKE_BROWSER || null;

// ── the public routes, and the locator that NAMES each one ──────────────────
//
// The locator is the point. "The page rendered something" is not a claim that
// can fail; "this route renders the thing this route is" can. Every locator is
// text that exists in the page's own source:
//
//   /             Landing.jsx  <h1>MORPHEUS</h1> — renders immediately, before
//                 the typed boot line finishes, so this asserts the route and
//                 not the animation
//   /terms        Terms.jsx → LegalPage <h1>TERMS OF SERVICE</h1>
//   /market       Market.jsx  <span>MORPHEUS MARKET</span>
//   /stats/alice  AliceStats  <h1>ALICEINTHEALICE</h1>
//   /start        Start.jsx redirects an unauthenticated visitor to /login BY
//                 DESIGN (it checks auth itself so the returnTo survives the
//                 sign-in round trip), so the assertion is on the DESTINATION.
//
// `path` is asserted too, because this repo's shipped bug was a link that
// landed somewhere else — a route that renders the right thing at the wrong
// URL (or bounces to the fallback) still passes a "did anything render" test.
const ROUTES = [
  { path: '/', name: 'landing', locator: 'h1', text: 'MORPHEUS', path: '/' },
  { path: '/terms', name: 'terms', locator: 'h1', text: 'TERMS OF SERVICE', path: '/terms' },
  { path: '/market', name: 'market', locator: 'text=MORPHEUS MARKET', path: '/market' },
  { path: '/stats/alice', name: 'stats-alice', locator: 'h1', text: 'ALICEINTHEALICE', path: '/stats/alice' },
  { path: '/start', name: 'start', locator: 'text=Welcome back', path: '/login' },
];

// ── the built app, served with the SPA fallback Netlify applies ─────────────
//
// public/_redirects is `/*  /index.html  200`, so a path with no file behind it
// is index.html and client-side routing takes over. Serving that rule by hand
// (rather than `vite preview`) means this file states the rule it tests instead
// of inheriting one from a Vite version.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.webmanifest': 'application/manifest+json',
};

/** Resolve a URL path to a real file under DIST, or null. Traversal-safe. */
function distFile(urlPath) {
  let p;
  try { p = normalize(decodeURIComponent(urlPath.split('?')[0].split('#')[0])); } catch { return null; }
  if (p === '/' || p === '') p = '/index.html';
  const abs = resolve(DIST, '.' + (p.startsWith('/') ? p : `/${p}`));
  if (abs !== DIST && !abs.startsWith(DIST + sep)) return null;
  return existsSync(abs) ? abs : null;
}

/**
 * One origin serving BOTH halves: the built frontend, and a stub for the
 * relative `/api/*` calls the app makes. Same-origin on purpose — that is how
 * the app is deployed (nginx / docker-compose), and it means the app can never
 * see a connection error or a CORS failure that would read here as a product
 * bug.
 */
async function startServer() {
  const server = createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      // Deliberately EMPTY and deliberately uniform: `{}` is a valid body for
      // every shape the client reads (it destructures `.data`, `.templates`,
      // `.categories`, `.user` — all of which are undefined, not a crash). No
      // token is seeded, so /auth/me is never reached at all; answering it
      // anyway costs nothing and keeps a future route from reading as a
      // render failure here.
      const body = Buffer.from('{}');
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
      res.end(body);
      return;
    }

    let file = distFile(urlPath);
    // The SPA fallback, explicitly: a path with no file behind it is a
    // client-side route, not a missing asset. A path WITH an extension is an
    // asset and is allowed to 404 (a missing chunk must not be papered over
    // with index.html — that is the SPA-200 trap this whole job exists over).
    const looksLikeAsset = /\.[a-zA-Z0-9]+$/.test(urlPath);
    if (!file && !looksLikeAsset) file = join(DIST, 'index.html');

    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('render-smoke: not found');
      return;
    }

    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store', // always exercise the bytes just built
      'content-length': body.length,
    });
    res.end(body);
  });

  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// ── reporting ───────────────────────────────────────────────────────────────
const failures = [];
const slug = (route) => route.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';

async function screenshot(page, route, label) {
  const file = join(OUT_DIR, `${slug(route)}__${label}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch (err) {
    console.log(`          (screenshot failed: ${err.message})`);
    return null;
  }
}

/** Console noise that says nothing about whether the page rendered. */
const BENIGN_CONSOLE = [/favicon/i, /\[vite\]/i, /Download the React DevTools/i];

// ── one route, in its own context ───────────────────────────────────────────
//
// A fresh context per route (not a fresh page in one context) is deliberate:
// nothing a previous route wrote to localStorage can change what the next one
// renders, so a failure cannot be an artifact of route order.
async function checkRoute(browser, base, spec) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // Nothing beyond this origin is reached — see the header. Playwright routes
  // only the browser's own requests, so this is also the reason no real network
  // is needed at all.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    const kind = route.request().resourceType();
    if (kind === 'xhr' || kind === 'fetch') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });

  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (BENIGN_CONSOLE.some((re) => re.test(text))) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => pageErrors.push(err?.stack || String(err)));
  // A 4xx/5xx for a same-origin asset is a broken build, and Chrome's console
  // message for it does not always name the URL — so keep the response side.
  const badResponses = [];
  page.on('response', (res) => {
    if (res.status() >= 400 && res.url().startsWith(base)) badResponses.push(`${res.status()} ${res.url().replace(base, '')}`);
  });

  const problems = [];
  let title = '';
  try {
    await page.goto(base + spec.path, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    // The page's OWN locator is what "rendered" means; `visible` auto-waits, so
    // a route that only ever mounts a spinner fails here rather than passing.
    const target = page.locator(spec.locator).first();
    await target.waitFor({ state: 'visible', timeout: ROUTE_TIMEOUT_MS });
    const rendered = ((await target.textContent()) || '').trim().replace(/\s+/g, ' ');
    // Assert the TEXT, not just that a selector matched. `h1` exists on the
    // 404 page too — a check that only counted elements would call a deleted
    // route a pass.
    if (spec.text && !rendered.toUpperCase().includes(spec.text.toUpperCase())) {
      problems.push(`rendered ${JSON.stringify(spec.locator)} but its text was ${JSON.stringify(rendered)} — expected it to contain ${JSON.stringify(spec.text)}`);
    }
    // React's first render replaces #root's children, so the pre-mount shell is
    // gone. Cheap proof the mount happened, rather than matching raw HTML.
    if (await page.locator('#morpheus-initial-loader').count()) {
      problems.push('the pre-mount loader (#morpheus-initial-loader) is still in the DOM — React never replaced the shell');
    }
    const landed = new URL(page.url()).pathname;
    if (landed !== spec.path) problems.push(`landed on ${landed}, expected ${spec.path}`);
  } catch (err) {
    problems.push(err.message.split('\n')[0]);
  }
  title = await page.title().catch(() => '');

  if (pageErrors.length) problems.push(`unhandled page error: ${pageErrors[0].split('\n')[0]}`);
  if (consoleErrors.length) problems.push(`${consoleErrors.length} console error(s), first: ${consoleErrors[0].slice(0, 300)}`);
  if (badResponses.length) problems.push(`failed request(s): ${badResponses.slice(0, 3).join(', ')}`);

  const shot = problems.length ? await screenshot(page, spec.path, 'FAILED') : null;
  await context.close();

  if (problems.length) {
    failures.push({ route: spec.path, name: spec.name, problems, screenshot: shot });
    console.log(`  FAIL  ${spec.path.padEnd(14)} ${spec.name}`);
    for (const p of problems) console.log(`          ${p}`);
    if (shot) console.log(`          screenshot: ${shot}`);
  } else {
    console.log(`  PASS  ${spec.path.padEnd(14)} ${spec.name}  ("${spec.text || spec.locator}" rendered, title "${title}")`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error(`\n  ✗ no built app at ${DIST}/index.html — run \`npm run build\` first.\n`);
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });

  console.log('\nrender-smoke — a real browser against the built app\n');
  const { server, origin } = await startServer();
  console.log(`  serving ${DIST.replace(REPO + '/', '')} (with the SPA fallback) at ${origin}`);
  console.log(`  screenshot dir: ${OUT_DIR.replace(REPO + '/', '')}\n`);

  let browser;
  try {
    browser = await chromium.launch({
      channel: CHROME_PATH ? undefined : CHROME_CHANNEL,
      executablePath: CHROME_PATH || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-crashpad'],
    });
  } catch (err) {
    console.error(`  ✗ could not launch a browser (channel "${CHROME_CHANNEL}"): ${err.message.split('\n')[0]}`);
    console.error('    The job must provide one — the runner\'s Chrome, or `npx playwright install chrome`.');
    console.error('    Set RENDER_SMOKE_BROWSER=/path/to/chrome to point at a specific binary.\n');
    server.close();
    process.exit(1);
  }

  try {
    for (const spec of ROUTES) await checkRoute(browser, origin, spec);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  const total = ROUTES.length;
  const failed = failures.length;
  console.log(`\n${total - failed}/${total} public routes rendered`);

  // The machine-readable half: CI uploads the directory, and the report is what
  // makes a red advisory job debuggable rather than a shrug.
  const report = {
    generatedAt: new Date().toISOString(),
    origin,
    routes: total,
    failed,
    failures,
  };
  const reportPath = join(OUT_DIR, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  if (failed) {
    console.log('\nA route that does not render is a page nobody can use. Each failure');
    console.log('above names the route; the screenshot is the artifact:\n');
    for (const f of failures) console.log(`  ${f.route}  →  ${f.screenshot || '(no screenshot)'}`);
    console.log(`\n  report: ${reportPath.replace(REPO + '/', '')}`);
    console.log('\n  ✗ render smoke failed\n');
    process.exit(1);
  }
  console.log('  ✓ every public route rendered in a real browser\n');
}

await main();
