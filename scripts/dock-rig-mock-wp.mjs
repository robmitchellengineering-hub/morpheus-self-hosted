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
const PLUGIN_VERSION = '0.8.4';

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
 * `?position=bottom-left` prints `data-position` too, so the flip-h geometry can
 * be driven as well as the default bottom-right.
 *
 * The token is read from the rig's own state file at request time (the file is
 * gitignored and local), never baked into this script.
 */
function hostPage(position) {
  let token = '';
  try { token = JSON.parse(readFileSync(STATE_FILE, 'utf8')).tokens.full.token; } catch { /* not seeded yet */ }
  const positionAttr = position ? ` data-position="${position}"` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Rig Fixture Site</title></head>
<body style="font-family:system-ui;background:#0b0b0b;color:#e6e6e6;margin:0;padding:32px">
  <h1>Rig Fixture Site</h1>
  <p id="fixture-note">A host page for the dock rig. The Morpheus dock below is public/plugin.js
  loading the same tag the WordPress plugin prints for a logged-in administrator.</p>
  ${token ? `<script src="${EMBED_ORIGIN}/plugin.js" data-token="${token}" data-dock="1"${positionAttr}></script>` : '<!-- not seeded yet: no widget token in state.json -->'}
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

/**
 * CLEAN MY SITE, as the plugin answers it.
 *
 * The findings carry the SAME shape class-clean.php builds, including `details`
 * (the evidence rows) and the fix block, so the dock's CLEAN MY SITE section is
 * exercised against the real payload rather than a convenient one. Two are
 * `auto` — the ones the single press may quarantine — and the rest are `guided`,
 * which must render steps and NO press. `limits` and `skipped` are non-empty on
 * purpose: the "what this scan did not reach" panel is part of the answer and a
 * fixture that omitted it would let a regression there pass.
 */
function clean() {
  return {
    ok: true,
    scan_version: 1,
    plugin_version: PLUGIN_VERSION,
    wp_version: '6.7.1',
    php_version: '8.2.33',
    generated_at: new Date().toISOString(),
    duration_ms: 4210,
    cached: false,
    limits: {
      seconds: 4.21,
      hash_files: 3224,
      hash_files_cap: 4000,
      uploads_scanned: 918,
      uploads_cap: 6000,
      package_plugins: 1,
      package_plugins_cap: 3,
      package_bytes: 133795,
      package_bytes_cap: 4194304,
    },
    skipped: [
      { check: 'plugin_checksums', reason: 'Morpheus itself is not hosted on wordpress.org, so there is no published package to compare its own files against' },
    ],
    unmapped: [],
    findings: [
      {
        id: 'morpheus_uploads_php',
        label: 'No PHP file is sitting in the uploads folder',
        status: 'critical',
        description: '2 files under wp-content/uploads can be run as PHP by the web server. Nothing legitimate puts executable code in a media library.',
        details: [
          { file: 'wp-content/uploads/2026/09/loader.php', size: 812, mtime_iso: '2026-09-22T01:04:00+00:00' },
          { file: 'wp-content/uploads/2026/09/x.php', size: 240, mtime_iso: '2026-09-22T01:02:00+00:00' },
        ],
        fix: { kind: 'auto', label: 'Quarantine the PHP files in uploads', does: 'Renames each .php file to a timestamped backup beside it. Nothing is deleted.', warning: null, steps: [] },
      },
      {
        id: 'morpheus_root_config_backup',
        label: 'No copy of wp-config.php or .env is sitting in the site root',
        status: 'critical',
        description: 'Found wp-config.php.bak in the site root. wp-config.php holds the database password and every API key on the site.',
        details: [{ file: 'wp-config.php.bak', size: 3120, mtime_iso: '2026-08-30T09:00:00+00:00' }],
        fix: { kind: 'auto', label: 'Move the config backups out of the web root', does: 'Moves the copy out of the site root under a timestamped name.', warning: null, steps: [] },
      },
      {
        id: 'morpheus_core_checksums',
        label: 'Every WordPress core file matches the published version',
        status: 'critical',
        description: '1 core file out of 3224 does not match the published checksum. This is reported, never repaired from here.',
        details: [{ file: 'wp-includes/version.php', size: 1100, mtime_iso: '2026-09-21T22:10:00+00:00' }],
        fix: { kind: 'guided', label: 'Replace the modified core files', does: 'Re-installing WordPress over a live site is your decision.', warning: null, steps: [{ text: 'Take a full backup first.', link: '/wp-admin/update-core.php' }] },
      },
      {
        id: 'morpheus_recent_files',
        label: 'Nothing has changed on this site in the last 7 days',
        status: 'recommended',
        description: '6 files under core, your plugins or your active theme have changed in the last 7 days.',
        details: [{ file: 'wp-content/plugins/akismet/akismet.php', size: 2400, mtime_iso: '2026-09-22T01:00:00+00:00' }],
        fix: { kind: 'guided', label: 'Compare the recent file changes', does: 'A plugin or theme update produces exactly this list.', warning: null, steps: [{ text: 'Line the timestamps up against what you installed.' }] },
      },
      {
        id: 'morpheus_public_debug_log',
        label: 'The debug log is not readable over the web',
        status: 'good',
        description: 'There is no wp-content/debug.log on this site, so nothing is being leaked by one.',
        fix: { kind: 'auto', label: 'Quarantine the public debug log', does: 'Renames wp-content/debug.log to a timestamped backup.', warning: null, steps: [] },
      },
      {
        id: 'morpheus_stale_robots_txt',
        label: 'robots.txt is built by WordPress, and its sitemap answers',
        status: 'good',
        description: 'There is no physical robots.txt in the site root, so WordPress builds it on every request.',
        fix: { kind: 'auto', label: 'Quarantine the stale robots.txt', does: 'Renames robots.txt to a timestamped backup beside it.', warning: null, steps: [] },
      },
      {
        id: 'morpheus_mu_plugins',
        label: 'Nothing is loaded from mu-plugins that you did not put there',
        status: 'good',
        description: '1 file in wp-content/mu-plugins is auto-loaded on every request, invisible in the Plugins screen.',
        details: [{ file: 'wp-content/mu-plugins/host-cache.php', size: 900, mtime_iso: '2026-09-01T00:00:00+00:00', note: 'loaded automatically' }],
        fix: { kind: 'guided', label: 'Check the mu-plugins inventory', does: 'Only you can say which of these are yours.', warning: null, steps: [{ text: 'Read each file named in the finding.' }] },
      },
      {
        id: 'morpheus_admin_users',
        label: 'Every account that can reach wp-admin is one you recognise',
        status: 'recommended',
        description: '2 accounts can reach the admin area on this site. 1 registered within the last 7 days.',
        details: [{ file: 'fixture-owner <owner@example.test>', mtime_iso: '2026-09-20T10:00:00+00:00', note: 'roles: administrator; registered in the last 7 days' }],
        fix: { kind: 'guided', label: 'Review the administrator accounts', does: 'Morpheus never removes an account.', warning: null, steps: [{ text: 'Confirm you recognise every administrator.', link: '/wp-admin/users.php' }] },
      },
      {
        id: 'morpheus_cron_unattributed',
        label: 'Every scheduled task belongs to something installed on this site',
        status: 'recommended',
        description: '1 scheduled hook could not be attributed to WordPress or to any plugin this site runs.',
        details: [{ file: 'fixture_leftover_hook', note: 'next run 2026-09-24T02:00:00+00:00' }],
        fix: { kind: 'guided', label: 'Check the unattributed scheduled tasks', does: 'Morpheus will not unschedule anything.', warning: null, steps: [{ text: 'Search the hook name in the plugins you run.' }] },
      },
      {
        id: 'morpheus_plugin_checksums',
        label: 'Every plugin file matches the version wordpress.org publishes',
        status: 'good',
        description: '1 plugin package downloaded and compared file by file; every file matches.',
        fix: { kind: 'guided', label: 'Re-install the affected plugin', does: 'Only if a file differs.', warning: null, steps: [{ text: 'Note the plugin named in the finding.' }] },
      },
    ],
  };
}

/** The auto findings the single press may quarantine, and their mock results. */
const CLEAN_AUTO = ['morpheus_uploads_php', 'morpheus_root_config_backup', 'morpheus_public_debug_log', 'morpheus_stale_robots_txt'];

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
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  // The site's own front page — with the dock tag on it, for /wp-admin's admin.
  if (req.method === 'GET' && (path === '/' || path === '/index.php')) {
    // Only the value the loader understands, so a query string can never put
    // arbitrary markup into this page.
    const position = url.searchParams.get('position') === 'bottom-left' ? 'bottom-left' : '';
    console.log(`[mock-wp] GET / (host page with the dock tag${position ? `, position=${position}` : ''})`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(hostPage(position));
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

  // The route the app sends BOTH scans to; the action decides which one it gets.
  // A rename on either side here would make CLEAN MY SITE render a health scan,
  // which reads as "nothing found" — so the rig drives the real dispatch.
  if (path === `${NS}/health`) {
    if (asAction === 'clean') { console.log('[mock-wp]   action=clean -> the clean scan'); return json(res, 200, clean()); }
    return json(res, 200, health());
  }
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
  if (path === `${NS}/fix`) {
    // A guided finding is declined, exactly as the real plugin declines it, so
    // the rig proves the press never reaches one. An auto finding answers with a
    // real quarantine result: the renamed file and its backup, which is what the
    // panel turns into the operator's undo line.
    // The app sends the finding under `finding` (lib/wpPlugin.js's wpFix), so the
    // mock reads the same field the real plugin does — reading only `id` here made
    // every press look declined, which is a mock bug that would have hidden a real
    // one behind it.
    const findingId = payload.finding || payload.id || '';
    if (!CLEAN_AUTO.includes(findingId)) {
      return json(res, 409, { ok: false, code: 'NOT_AUTOMATIC', error: 'mock-wp: this finding needs a person' });
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const file = findingId === 'morpheus_uploads_php' ? 'wp-content/uploads/2026/09/loader.php'
      : findingId === 'morpheus_root_config_backup' ? 'wp-config.php.bak'
        : findingId === 'morpheus_public_debug_log' ? 'wp-content/debug.log'
          : 'robots.txt';
    const backup = `/home/fixture/${file.split('/').pop()}.morpheus-bak-${stamp}`;
    return json(res, 200, {
      ok: true,
      id: findingId,
      code: 'QUARANTINED',
      did: 'renamed 1 file with a timestamp — nothing was deleted',
      quarantined: [{ file, backup, verified: true, restored: false, served: false }],
      refused: [],
      verified: true,
      restored: false,
      error: null,
    });
  }
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
