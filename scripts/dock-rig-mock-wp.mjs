#!/usr/bin/env node
/**
 * Mock WordPress for the dock rig — the operator's own site, as far as
 * server/src/lib/wpPlugin.js is concerned.
 *
 * It answers the routes the dock's tabs actually call:
 *
 *   GET  /wp-json/morpheus/v1/status   — unauthenticated plugin identity
 *   POST /wp-json/morpheus/v1/health   — the signed site-health scan
 *   POST /wp-json/morpheus/v1/store    — the signed shop context
 *   POST /wp-json/morpheus/v1/seo      — the signed SEO context
 *   POST .../deploy, /traffic, /dock, /updates, /maintenance, /fix, /export
 *
 * Every POST is HMAC-verified against MOCK_WP_SECRET. That is the point of it
 * being a mock rather than a stub: a 401 here means the dock's signed path
 * really is signed (server/src/lib/wpPlugin.js signs the raw body with the
 * secret stored on the PluginConnection row), so a green run cannot come from
 * an unsigned request that a lenient fake accepted. With no MOCK_WP_SECRET set
 * the signature is reported but not enforced, and the server says so at boot.
 *
 *   MOCK_WP_SECRET=... node scripts/dock-rig-mock-wp.mjs   # listens on :4600
 */
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(REPO, 'server', 'data', 'dock-rig', 'state.json');
const EMBED_ORIGIN = process.env.MOCK_WP_EMBED_ORIGIN || 'http://localhost:5173';

const PORT = Number(process.env.MOCK_WP_PORT || 4600);
const SECRET = process.env.MOCK_WP_SECRET || '';
const NS = '/wp-json/morpheus/v1';
const PLUGIN_VERSION = '0.8.2';

const json = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

/**
 * A real WordPress page carrying the tag the plugin prints for its own admin:
 * `<script src="…/plugin.js" data-token="…" data-dock="1">`. Serving it here is
 * what lets the rig drive public/plugin.js itself — the shadow-root toggle,
 * the iframe it creates, and the /embed page inside it — rather than only the
 * embed URL that a human would otherwise have to paste.
 *
 * The token is read from the rig's own state file at request time (the file is
 * gitignored and local), never baked into this script.
 */
function hostPage() {
  let token = '';
  try { token = JSON.parse(readFileSync(STATE_FILE, 'utf8')).tokens.full.token; } catch { /* not seeded yet */ }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Rig Fixture Site</title></head>
<body style="font-family:system-ui;background:#0b0b0b;color:#e6e6e6;margin:0;padding:32px">
  <h1>Rig Fixture Site</h1>
  <p id="fixture-note">A host page for the dock rig. The Morpheus dock below is public/plugin.js
  loading the same tag the WordPress plugin prints for a logged-in administrator.</p>
  ${token ? `<script src="${EMBED_ORIGIN}/plugin.js" data-token="${token}" data-dock="1"></script>` : '<!-- not seeded yet: no widget token in state.json -->'}
</body></html>`;
}

// ── the site, as a fixture ─────────────────────────────────────────────────
function health() {
  const checkedAt = Math.floor(Date.now() / 1000) - 3600; // an hour ago: fresh
  return {
    ok: true,
    wp_version: '6.7.1',
    php_version: '8.2.33',
    update_checked_at: checkedAt,
    can: { update_files: true },
    host: {
      can_update_files: true,
      blockers: [],
      webserver: 'nginx/1.25.3',
      php_max_execution_time: 120,
      disk_free_bytes: 4_294_967_296,
    },
    auto_updates: { core_minor: 'unset', core_major: false, plugins: true, themes: false },
    tests: [
      { id: 'php_version', label: 'PHP Version', status: 'good', badge: 'Performance', description: 'PHP 8.2.33 is supported and current.', links: [] },
      { id: 'rest_api', label: 'REST API availability', status: 'good', badge: 'Security', description: 'The REST API is reachable.', links: [] },
      { id: 'debug_enabled', label: 'Debug mode', status: 'recommended', badge: '', description: 'Debug logging is on for a production site.', links: [{ url: `http://localhost:${PORT}/wp-admin/`, label: 'Manage' }] },
    ],
    own_checks: [
      { id: 'morpheus_plugin_version', label: 'Morpheus plugin', status: 'good', badge: '', description: `Morpheus plugin ${PLUGIN_VERSION} is installed and current.`, links: [] },
      { id: 'morpheus_theme_writable', label: 'Active theme is writable', status: 'good', badge: '', description: 'Theme files can be written by WordPress.', links: [] },
    ],
    updates: {
      plugins: [{ name: 'Akismet Anti-Spam', file: 'akismet/akismet.php', version: '5.3', new_version: '5.4' }],
      themes: [],
      core: [],
    },
    async_not_run: [
      { id: 'https_status', label: 'HTTPS status', reason: 'WordPress runs this test in the browser; a signed server scan cannot.' },
      { id: 'background_updates', label: 'Background updates', reason: 'WordPress runs this test in the browser; a signed server scan cannot.' },
    ],
  };
}

const STORE_CONTEXT = {
  ok: true,
  currency: 'USD',
  currency_symbol: '$',
  categories: [
    { id: 15, name: 'Amplifiers', slug: 'amplifiers', count: 4 },
    { id: 16, name: 'Effects', slug: 'effects', count: 7 },
    { id: 17, name: 'Guitars', slug: 'guitars', count: 3 },
  ],
  brand_taxonomy: 'product_brand',
  brands: [
    { id: 21, name: 'Mocktone', slug: 'mocktone', count: 2 },
    { id: 22, name: 'Rigworks', slug: 'rigworks', count: 1 },
  ],
  default_status: 'draft',
};

const SEO_CONTEXT = {
  ok: true,
  site_title: 'Rig Fixture Site',
  tagline: 'Mocked for the dock rig',
  owns_head: true,
  active_plugin: 'none',
  defaults: { enabled: false, title: '', description: '' },
};

// ── signature ──────────────────────────────────────────────────────────────
const expectedSignature = (raw) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');

function signatureOk(req, raw) {
  if (!SECRET) return { ok: true, checked: false };
  const got = String(req.headers['x-morpheus-signature'] || '');
  const want = expectedSignature(raw);
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, checked: true };
}

let posts = 0;
function respond(req, res, raw) {
  const path = (req.url || '').split('?')[0];

  // The site's own front page — with the dock tag on it, for /wp-admin's admin.
  if (req.method === 'GET' && (path === '/' || path === '/index.php')) {
    console.log('[mock-wp] GET / (host page with the dock tag)');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(hostPage());
  }

  // A browser asks for this unprompted; without it the rig's "no console errors"
  // check fails on a mock artefact instead of on the dock.
  if (req.method === 'GET' && path === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && path === `${NS}/status`) {
    console.log('[mock-wp] GET /status');
    return json(res, 200, {
      ok: true,
      plugin: 'morpheus',
      version: PLUGIN_VERSION,
      armed: false,
      home_url: `http://localhost:${PORT}`,
      store: { available: true, woocommerce: { version: '9.4.1' } },
      seo: { available: true, owns_head: true, active_plugin: 'none' },
    });
  }

  if (req.method !== 'POST') return json(res, 404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' });

  const sig = signatureOk(req, raw);
  const action = path.split('/').pop();
  posts += 1;
  if (!sig.ok) {
    console.log(`[mock-wp] POST /${action}  BAD SIGNATURE -> 401`);
    return json(res, 401, { code: 'morpheus_bad_signature', message: 'Signature did not verify.' });
  }
  console.log(`[mock-wp] POST /${action}  signature=${sig.checked ? 'verified' : 'UNCHECKED (no MOCK_WP_SECRET)'}`);

  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { /* treat as empty */ }
  const asAction = payload.action || '';

  if (path === `${NS}/health`) return json(res, 200, health());
  if (path === `${NS}/store`) {
    if (asAction === 'context') return json(res, 200, STORE_CONTEXT);
    if (asAction === 'list_products') return json(res, 200, { ok: true, products: [] });
    return json(res, 200, { ok: true, action: asAction });
  }
  if (path === `${NS}/seo`) {
    if (asAction === 'context') return json(res, 200, SEO_CONTEXT);
    if (asAction === 'list_content') return json(res, 200, { ok: true, items: [] });
    if (asAction === 'audit') return json(res, 200, { ok: true, issues: [], counts: { high: 0, medium: 0, low: 0 }, scanned: 0 });
    return json(res, 200, { ok: true, action: asAction });
  }
  if (path === `${NS}/deploy`) return json(res, 200, { ok: true, dry_run: true, note: 'mock-wp: deploy is a no-op in the rig' });
  if (path === `${NS}/traffic`) return json(res, 200, { ok: true, action: asAction, submitted: 0 });
  if (path === `${NS}/updates`) return json(res, 200, { ok: true, updates: { plugins: 1, themes: 0, core: 0 } });
  if (path === `${NS}/maintenance`) return json(res, 200, { ok: true, action: asAction, targets: [] });
  if (path === `${NS}/dock`) return json(res, 200, { ok: true, enabled: true, configured: true, note: 'mock-wp: dock token stored' });
  if (path === `${NS}/fix`) return json(res, 409, { ok: false, code: 'NOT_AUTOMATIC', error: 'mock-wp: this finding needs a person' });
  return json(res, 404, { code: 'rest_no_route', message: `mock-wp: no route for ${path}` });
}

createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    try { respond(req, res, raw); } catch (err) { json(res, 500, { error: err.message }); }
  });
}).listen(PORT, () => {
  console.log(`[mock-wp] mock WordPress plugin on http://localhost:${PORT} (plugin ${PLUGIN_VERSION})`);
  if (!SECRET) console.log('[mock-wp] WARNING: MOCK_WP_SECRET is not set — signatures are logged but NOT verified.');
});
