// Talking to a Morpheus WordPress plugin on the operator's own site.
//
// The connection ({ site URL, shared signing secret }) is a PluginConnection
// row, secret encrypted at rest. Every write to the plugin is HMAC-SHA256
// signed over the raw JSON body — the same X-Morpheus-Signature header the
// plugin verifies, and the same signDeployBody() the WordPress delivery
// adapter uses.
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';

const WP_NS = 'morpheus/v1';
const TIMEOUT_MS = 25_000;

export function isMissingPluginTable(err) {
  const m = err && typeof err.message === 'string' ? err.message : '';
  return err?.code === 'P2021' || err?.code === 'P2022'
    || /relation\s+"?plugin_connections"?\s+does not exist/i.test(m)
    || /Cannot read properties of undefined \(reading '(find|findFirst|create|update|upsert|delete)/i.test(m);
}

export function signBody(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function normalizeSiteUrl(raw) {
  if (typeof raw !== 'string') return '';
  let u = raw.trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return '';
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

// → { id, siteUrl, secret, repo, meta } | null. Secret is decrypted.
export async function getWpConnection(projectId, userId, kind = 'wordpress') {
  try {
    const row = await prisma.pluginConnection.findFirst({
      where: { project_id: projectId, kind, created_by_id: userId },
    });
    if (!row) return null;
    return {
      id: row.id,
      siteUrl: row.site_url,
      secret: decrypt(row.webhook_secret),
      repo: row.repo || null,
      meta: row.meta ? safeJson(row.meta) : null,
      updatedAt: row.updated_date,
    };
  } catch (err) {
    if (isMissingPluginTable(err)) return null;
    throw err;
  }
}

export async function upsertWpConnection(projectId, userId, { siteUrl, secret, repo, meta }) {
  const data = {
    site_url: siteUrl,
    webhook_secret: encrypt(secret),
    repo: repo || null,
    meta: meta ? JSON.stringify(meta) : null,
  };
  return prisma.pluginConnection.upsert({
    where: { project_id_kind: { project_id: projectId, kind: 'wordpress' } },
    update: data,
    create: { ...data, project_id: projectId, created_by_id: userId, kind: 'wordpress' },
  });
}

export async function deleteWpConnection(projectId, userId) {
  try {
    await prisma.pluginConnection.deleteMany({ where: { project_id: projectId, created_by_id: userId, kind: 'wordpress' } });
    return true;
  } catch (err) {
    if (isMissingPluginTable(err)) return false;
    throw err;
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

async function wpFetch(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    return {
      status: res.status,
      ok: res.ok,
      data,
      // Needed by callers that follow redirects themselves (see wpStatus), and
      // by the connect wizard to recognise WordPress: every WP REST response
      // carries `Link: <…/wp-json/>; rel="https://api.w.org/"`, including a 404
      // for a route that does not exist. That header is how a site without the
      // Morpheus plugin is still identified AS WordPress.
      location: res.headers?.get ? res.headers.get('location') : null,
      link: res.headers?.get ? res.headers.get('link') : null,
    };
  } catch (err) {
    return { status: 0, ok: false, data: null, error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * GET /status — unauthenticated; confirms the plugin is installed and which
 * modules are live.
 *
 * Redirects are followed BY HAND (at most three) rather than by fetch, because
 * the two most common reasons a real site does not answer are both visible in
 * the redirect chain, and both used to be reported as the useless "fetch
 * failed":
 *
 *   * a site behind a login wall or a "coming soon" mode redirects everything
 *     to wp-login.php — including the REST route Morpheus needs;
 *   * a redirect loop (http↔https, www↔non-www misconfiguration) never lands.
 *
 * `finalUrl` and `redirects` are reported so the connect wizard can say which
 * of those it is instead of asking the operator to check their spelling.
 */
export async function wpStatus(siteUrl, { maxRedirects = 3 } = {}) {
  let url = `${siteUrl}/wp-json/${WP_NS}/status`;
  const chain = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await wpFetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'Morpheus', Accept: 'application/json' },
    });
    if (res.status === 0) return { ...res, finalUrl: url, redirects: chain };
    // 3xx with a Location we can resolve against the current URL.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.location;
      if (!loc) return { ...res, finalUrl: url, redirects: chain };
      let next;
      try {
        next = new URL(loc, url).toString();
      } catch {
        return { ...res, finalUrl: url, redirects: chain };
      }
      chain.push(next);
      url = next;
      continue;
    }
    return { ...res, finalUrl: url, redirects: chain };
  }
  return {
    status: 0,
    ok: false,
    data: null,
    error: `too many redirects (${chain.length})`,
    finalUrl: url,
    redirects: chain,
  };
}

// Signed POST to one of the plugin's endpoints (store | deploy | rollback | seo).
export async function wpCall(conn, endpoint, payload) {
  const raw = JSON.stringify({ ...payload, at: new Date().toISOString() });
  return wpFetch(`${conn.siteUrl}/wp-json/${WP_NS}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Morpheus',
      'X-Morpheus-Signature': signBody(conn.secret, raw),
    },
    body: raw,
  });
}

/**
 * Trade a pairing code for the shared secret this site will accept.
 *
 * The one call that is NOT signed — there is no secret yet; the code is the
 * credential (single use, 20 minutes, five wrong attempts cancel it). The
 * response carries the secret, so this refuses a non-https site: sending a
 * secret in clear text across the open internet is worse than asking the
 * operator to connect over https.
 */
export async function wpPair(siteUrl, code) {
  if (!/^https:\/\//i.test(siteUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(siteUrl)) {
    return {
      status: 0,
      ok: false,
      data: null,
      error: 'Pairing needs an https site — the connection secret is sent in the response, so it must not travel in clear text.',
    };
  }
  const raw = JSON.stringify({ code: String(code || '').trim() });
  return wpFetch(`${siteUrl}/wp-json/${WP_NS}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Morpheus', Accept: 'application/json' },
    body: raw,
  });
}

/**
 * Does the secret we hold actually match the one set on the site?
 *
 * /status is unauthenticated, so it can only say *a* secret is set — not that
 * it is ours. The cheapest signed call that exists on every plugin version is
 * a deploy request with a deliberately invalid commit: the signature is checked
 * before the commit is, so a verified signature comes back 400 "commit must be
 * a git SHA" and a wrong one comes back 401. Nothing is deployed (the commit
 * never reaches the deployer), and the operator learns the truth at connect
 * time instead of on their first real action.
 */
export async function wpVerifySecret(conn) {
  const res = await wpCall(conn, 'deploy', { commit: '0', dry_run: true });
  if (res.status === 0) return { ok: false, reason: 'unreachable', error: res.error };
  if (res.status === 401) return { ok: false, reason: 'mismatch' };
  // 400 is the expected answer: the signature passed, the commit was rejected.
  if (res.status === 400 && res.data?.error === 'bad_request') return { ok: true };
  // Anything else (200 from a plugin that skipped the commit check, 403 from a
  // site-level block) is not a signature failure, so it is not treated as one.
  return { ok: true, note: `unexpected ${res.status}` };
}

// Export-module convenience: the active theme as a working copy. See the
// plugin's includes/class-export.php — text files only, capped, hashed.
export async function wpExportThemeTree(conn) {
  return wpCall(conn, 'export', { action: 'theme_tree', data: {} });
}

export async function wpExportThemeFiles(conn, paths) {
  return wpCall(conn, 'export', { action: 'theme_files', data: { paths } });
}

// Store-module convenience: wpCall(conn, 'store', { action, data }).
export async function wpStore(conn, action, data = {}) {
  return wpCall(conn, 'store', { action, data });
}

// SEO-module convenience: wpCall(conn, 'seo', { action, data }).
// Actions: context | list_content | read_content | get_seo | set_seo |
// bulk_set_seo | audit. The plugin decides where a value lives (its own
// postmeta, or the active SEO plugin's) — see wp-plugin includes/seo/class-seo.php.
export async function wpSeo(conn, action, data = {}) {
  return wpCall(conn, 'seo', { action, data });
}

/**
 * Traffic module (plugin 0.7.0+): IndexNow submission state, the submission
 * ledger, a bounded backfill, and the on/off toggle.
 *
 * The ledger is the point of the endpoint: it carries the UTC time, URL, action
 * and the HTTP status IndexNow actually returned, which is the only evidence a
 * traffic feature may show. There is no "indexed" field, because IndexNow does
 * not report one — a 2xx means the submission was accepted, nothing more.
 */
export const MIN_TRAFFIC_PLUGIN_VERSION = '0.7.0';

export async function wpTraffic(conn, action, data = {}) {
  return wpCall(conn, 'traffic', { action, data });
}

/**
 * Redirects and the 404 log (plugin 0.9.2+): `wpCall(conn, 'redirects', …)`.
 *
 * The plugin owns the rule list AND the log — it is the only place that sees a 404,
 * so the grouping and the bound are decided there and this side only reads and
 * writes rules. `id` travels beside `data` because update/delete name one rule and
 * a rule is not a field of the thing being edited.
 *
 * A build older than the release that added the route answers 400
 * `unknown_action`; `wordPressRedirects` turns that into "update the plugin"
 * rather than showing the operator a sentence about action names.
 */
export const MIN_REDIRECTS_PLUGIN_VERSION = '0.9.2';

export async function wpRedirects(conn, action, data = {}, id = '') {
  return wpCall(conn, 'redirects', { action, data, ...(id ? { id } : {}) });
}

/**
 * One-tap dock setup (plugin 0.8.2+).
 *
 * The site owns the dock: it holds the token and it decides whether to print.
 * This is the signed call that hands it the token the owner just minted, so a
 * person never carries a credential between two screens by hand.
 *
 * The response is the SITE's verdict — `{ ok, enabled, configured, note }` — and
 * never the token, so callers cannot echo it back by accident. A refusal carries
 * the same three fields as a success, which is what lets the panel show the
 * site's own reason rather than a generic failure.
 */
export const MIN_DOCK_ACTION_PLUGIN_VERSION = '0.8.2';

export async function wpDock(conn, action, data = {}) {
  return wpCall(conn, 'dock', { action, ...data });
}

/**
 * Site health + maintenance scan (plugin 0.6.0+).
 *
 * The only endpoint that returns the site's own configuration — plugin names and
 * versions, auto-update settings, whether files can even be written — so it is a
 * signed POST rather than a public GET like /status.
 *
 * A plugin older than 0.6.0 has no /health route, and WordPress answers a route
 * that does not exist with 404 `rest_no_route` (a route that exists but has no
 * such action answers 400 `unknown_action`). Both shapes mean the same thing
 * here — "this site's plugin is too old" — and both are named, because the raw
 * WordPress error tells an operator nothing they can act on.
 */
export const MIN_HEALTH_PLUGIN_VERSION = '0.6.0';

export async function wpHealth(conn, { force = false } = {}) {
  return wpCall(conn, 'health', force ? { force: true } : {});
}

/**
 * CLEAN MY SITE (plugin 0.8.4+): what is on the server that nobody asked for.
 *
 * The same signed /health route with a different action, so the auth, the
 * timestamp window and the answer shape are identical and there is no second
 * place for the signature check to be got wrong. It is its OWN request because
 * the scan is heavy — a checksum pass over core, plugins and uploads — so the
 * app decides when to spend it; opening the panel must not.
 *
 * A build older than 0.8.4 IGNORES the body and answers with a health scan, so a
 * 200 is not proof the action ran. `scanCleanSite()` in lib/siteScan.js checks
 * the payload shape, and this constant names the release that added the action.
 */
export const MIN_CLEAN_PLUGIN_VERSION = '0.8.4';

export async function wpClean(conn, { force = false } = {}) {
  return wpCall(conn, 'health', { action: 'clean', ...(force ? { force: true } : {}) });
}

/**
 * The site's PHP error log, READ rather than merely measured (plugin 0.9.1+).
 *
 * `Morpheus_Clean::debug_log_state()` has always opened this file — to decide
 * whether the web server is SERVING it, by comparing its bytes with the URL's.
 * Nothing anywhere read the error lines, so the one question an owner actually
 * has ("what is breaking on my site?") had no answer in Morpheus or in wp-admin.
 *
 * The same signed /health route with a third action, so the auth, the timestamp
 * window and the answer shape are unchanged and there is no second place for the
 * signature check to be got wrong. Its OWN request because a log is the one file
 * on a site that can be gigabytes: opening the health panel must not pull it.
 *
 * A build older than 0.9.1 IGNORES the body and answers with a health scan (or,
 * if it dispatches actions but has no `logs`, answers 400 unknown_action), so a
 * 200 is not proof the read happened. `readErrorLog()` in lib/siteScan.js checks
 * the payload shape, and this constant names the release that added the action.
 */
export const MIN_LOGS_PLUGIN_VERSION = '0.9.1';

export async function wpLogs(conn, { lines } = {}) {
  return wpCall(conn, 'health', { action: 'logs', ...(lines ? { lines: Number(lines) } : {}) });
}

/**
 * Site maintenance (plugin 0.6.0+): report what could be updated, or update it.
 *
 * `targets` are (kind, id) pairs and nothing else — no versions, no URLs. The
 * SITE re-reads its own update offer and decides, so a scan Morpheus took minutes
 * ago can never cause an install of something the site no longer offers. The site
 * also refuses outright when it cannot take a backup first; that refusal arrives
 * as `{ ok: false, code, error }` and is passed through, not swallowed.
 */
export async function wpMaintenance(conn, { action = 'plan', targets = [], dryRun = false } = {}) {
  return wpCall(conn, 'maintenance', { action, targets, dry_run: !!dryRun });
}

/**
 * Apply ONE registered fix by finding id (plugin 0.6.3+).
 *
 * The site owns the registry, so the id is all that crosses the wire — Morpheus
 * cannot invent an action, and the site answers NOT_AUTOMATIC for anything that
 * needs a human step. A plugin older than 0.6.3 has no /fix route, which is the
 * same "too old" shape as /health and is reported the same way.
 */
export async function wpFix(conn, id, proposal = null) {
  // A proposal is the operator having seen exactly what Morpheus will do and pressed
  // apply. It travels as data and is re-validated by the PLUGIN against the site's own
  // state before anything is written — this client is a pipe, not a gate.
  return wpCall(conn, 'fix', proposal ? { id, proposal } : { id });
}

/**
 * Undo the plugin's LAST deploy — restore the snapshot it took before writing.
 *
 * The plugin owns which deploy that is: `rollback_last()` reads its own
 * `morpheus_deploy_last` option and derives the snapshot directory itself, so
 * NOTHING is passed. That is deliberate rather than lazy — there is one snapshot
 * worth returning to, and an id the app could name would be an id the app could
 * get wrong.
 *
 * The route has existed and been tested since the Deploy module shipped; nothing
 * in the app called it until 2026-10-08, so `delivery/wordpress.js` advertised
 * `supports: ['rollback']` for a button that did not exist.
 *
 * Two refusals cross the wire as ordinary payloads (the plugin answers non-2xx
 * with `{ ok:false, error, message }`): `nothing_to_roll_back` (400) and
 * `snapshot_missing` (410 — the plugin keeps the last 5, so an old record's
 * snapshot can age out). The caller renders the plugin's own sentence rather
 * than inventing one.
 */
export async function wpRollback(conn) {
  return wpCall(conn, 'rollback', {});
}

/**
 * Force the plugin's OWN update check (plugin 0.6.4+), and report what is true.
 *
 * The plugin caches the published manifest and WordPress caches its own update
 * transient. A site whose caches predate a release is told "nothing to update",
 * and WordPress's own "Check again" cannot break through, because it re-runs the
 * check against the same cached answer. This clears both and re-reads.
 *
 * It CHECKS ONLY. There is deliberately no apply here: the request that would
 * install this plugin's update is served by the code being replaced, so
 * WordPress's own updater stays the only writer. A build older than 0.6.4 has no
 * /updates route — the bootstrap case, where the panel must offer the zip by
 * hand rather than pretend to have checked.
 */
export async function wpUpdates(conn, { action = 'check' } = {}) {
  return wpCall(conn, 'updates', { action });
}

