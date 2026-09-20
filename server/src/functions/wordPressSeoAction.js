// Run one SEO-module action on the connected WordPress plugin — read and write
// the SEO fields on any page/post/product, list content, read one item's text
// for generation, and audit the site for real problems.
//
// The plugin does the work; this signs and forwards. The split matters: the
// plugin knows which keys the site's ACTIVE SEO plugin reads (Yoast, Rank Math,
// AIOSEO, SEOPress) or whether Morpheus is emitting the tags itself, and
// Morpheus-side code deliberately does not duplicate that knowledge.
import { prisma } from '../db.js';
import { getWpConnection, wpSeo } from '../lib/wpPlugin.js';
import { logUsage } from '../lib/projectUtils.js';
import { policyIdForUser, assertWithinVelocity } from '../lib/tenantPolicy.js';
import { SEO_INPUT_KEYS } from '../lib/seoPrompts.js';

const ALLOWED = new Set([
  'context', 'list_content', 'read_content', 'get_seo', 'set_seo', 'bulk_set_seo', 'audit',
  'get_defaults', 'set_defaults', 'bulk_apply_defaults',
]);
const WRITE_ACTIONS = new Set(['set_seo', 'bulk_set_seo', 'set_defaults', 'bulk_apply_defaults']);

// A bulk write is one signed call the plugin loops over. 100 is well above any
// real generation batch (lib/seoPrompts.js caps a batch at 25) but low enough
// that a scripted caller can't hand the site a 10,000-post payload.
const MAX_BULK_ITEMS = 100;

/** Numeric post id, or null. Ids are the only field trusted across the wire. */
function postId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Keep only the field names the plugin actually accepts.
 *
 * The plugin ignores unknown keys, so a typo here would silently write nothing
 * and look like a plugin bug. Whitelisting means an unrecognised key is visible
 * in this handler's own code — and scripts/verify-seo.mjs asserts the whitelist
 * against class-seo.php's input map.
 */
function pickSeoFields(data = {}) {
  const out = {};
  for (const key of SEO_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
  }
  return out;
}

function cleanData(action, data) {
  const d = data && typeof data === 'object' ? data : {};
  if (action === 'set_seo') {
    // By id when we have one; otherwise pass the url through untouched and let
    // the plugin resolve it (resolve_post handles both).
    const id = postId(d.id);
    return id != null ? { id, ...pickSeoFields(d) } : { ...d };
  }
  if (action === 'bulk_set_seo') {
    const items = (Array.isArray(d.items) ? d.items : []).slice(0, MAX_BULK_ITEMS);
    return { items: items.map((it) => ({ ...pickSeoFields(it), id: postId(it?.id) })).filter((it) => it.id != null) };
  }
  // get_defaults/set_defaults carry a nested `defaults` object rather than item
  // fields, so they fall through to the plugin as-is. The plugin sanitises them
  // (tags stripped, unknown tokens removed, length capped) — doing it in two
  // places would just mean two different rules.
  if (action === 'get_seo' || action === 'read_content') {
    return { ...(d.chars ? { chars: d.chars } : {}), ...(postId(d.id) != null ? { id: postId(d.id) } : { url: d.url }) };
  }
  return d;
}

export default async function handler({ user, body }) {
  const { projectId, action, data } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!ALLOWED.has(action)) throw Object.assign(new Error(`Unknown seo action: ${action}`), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) throw Object.assign(new Error('No WordPress site connected — connect one in the SETUP panel first.'), { status: 400 });

  const payload = cleanData(action, data);
  if (action === 'bulk_set_seo' && payload.items.length === 0) {
    throw Object.assign(new Error('Nothing to write — no items with a usable id.'), { status: 400 });
  }

  // Plugin tenants: cap SEO writes per hour so a scripted loop can't rewrite a
  // whole site's metadata in a burst (no-op for the owner / self-dev).
  if (WRITE_ACTIONS.has(action)) {
    await assertWithinVelocity(user.id, policyIdForUser(user), 'wp_seo_write');
  }

  const res = await wpSeo(conn, action, payload);

  if (res.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502 });
  }

  // A plugin older than the SEO module answers 400 unknown_action. Saying so
  // plainly is the difference between "this site doesn't support it yet" and a
  // mystery failure the operator can't act on.
  if (res.status === 400 && res.data?.error === 'unknown_action') {
    throw Object.assign(new Error('This site\'s Morpheus plugin is out of date — update it from the SETUP tab to manage SEO.'), { status: 409 });
  }

  if (WRITE_ACTIONS.has(action) && res.data?.ok !== false) {
    await logUsage(user.id, 'wp_seo_write', projectId, project.name, {
      action,
      count: action === 'bulk_set_seo' ? (res.data?.count ?? payload.items.length) : 1,
    });
  }

  // Pass the plugin's own body + status straight through (it already has a
  // clean { ok, error, message } / { ok, item, ... } shape).
  return { httpStatus: res.status, ...(res.data || {}) };
}
