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
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    return { status: 0, ok: false, data: null, error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(t);
  }
}

// GET /status — unauthenticated; confirms the plugin is installed and which
// modules are live.
export async function wpStatus(siteUrl) {
  return wpFetch(`${siteUrl}/wp-json/${WP_NS}/status`, {
    method: 'GET',
    headers: { 'User-Agent': 'Morpheus', Accept: 'application/json' },
  });
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
