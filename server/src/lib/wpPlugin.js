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

