// Redirects and the 404 log for one connected WordPress site.
//
// One function with an `action`, the same shape as the Store module — the widget
// scope is a function-NAME allow-list, so one name to grant and one name to audit.
//
//   status    — the rule list, the counts, and what the plugin supports
//   log       — the 404 log, grouped by path by the plugin
//   create    — add a rule
//   update    — change one rule
//   delete    — remove one rule
//   clear_log — empty the 404 log
//   settings  — the module's own on/off
//
// THE PLUGIN DECIDES WHETHER A RULE IS ALLOWED, and that is deliberate rather than
// lazy: the refusals that matter here (a rule on wp-admin, a loop, a `javascript:`
// destination) are enforced on the site, so a caller that bypasses this function —
// a future surface, a different client — cannot get around them. This side validates
// only what it can see without asking: that an action exists, and that the operator
// meant a destructive one.
import { prisma } from '../db.js';
import { getWpConnection, wpRedirects, MIN_REDIRECTS_PLUGIN_VERSION } from '../lib/wpPlugin.js';
import { logUsage } from '../lib/projectUtils.js';
import { policyIdForUser, assertWithinVelocity } from '../lib/tenantPolicy.js';

const ALLOWED = new Set(['status', 'log', 'create', 'update', 'delete', 'clear_log', 'settings']);
const WRITE_ACTIONS = new Set(['create', 'update', 'delete', 'clear_log', 'settings']);

// Destructive or irreversible-feeling: removing a rule takes a URL's behaviour back
// to a 404, and clearing the log throws away the only record of what was missing.
// Both need the caller to have meant it — the same rule every other live write in
// this codebase follows.
const NEEDS_CONFIRM = new Set(['delete', 'clear_log']);

export default async function handler({ user, body }) {
  const { projectId, action, data, id, confirm = false } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!ALLOWED.has(action)) throw Object.assign(new Error(`Unknown redirects action: ${action}`), { status: 400 });

  if (NEEDS_CONFIRM.has(action) && confirm !== true) {
    throw Object.assign(
      new Error(action === 'delete'
        ? 'confirm:true is required — deleting a redirect sends that URL back to a 404'
        : 'confirm:true is required — clearing the log discards the record of what was missing'),
      { status: 400 },
    );
  }

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) throw Object.assign(new Error('No WordPress site connected — connect one in the WEBSITE panel first.'), { status: 400 });

  // Plugin tenants: cap write actions per hour so a loop cannot rewrite a site's
  // navigation faster than a person could (no-op for the owner / self-dev).
  if (WRITE_ACTIONS.has(action)) {
    await assertWithinVelocity(user.id, policyIdForUser(user), 'wp_redirect_write');
  }

  const res = await wpRedirects(conn, action, data && typeof data === 'object' ? data : {}, id ? String(id) : '');

  if (res.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502 });
  }

  // A build that predates the route answers 400 `unknown_action`. Saying so beats
  // relaying a sentence about action names, which reads as a Morpheus bug.
  if (res.status === 400 && res.data?.error === 'unknown_action') {
    throw Object.assign(
      new Error(`This site's Morpheus plugin is ${conn.meta?.pluginVersion || 'older than ' + MIN_REDIRECTS_PLUGIN_VERSION} and has no redirects module. Update the plugin in wp-admin → Plugins, then try again.`),
      { status: 409, code: 'PLUGIN_TOO_OLD' },
    );
  }

  if (res.status === 0 || res.status >= 500) {
    throw Object.assign(
      new Error(res.data?.message || `The site answered HTTP ${res.status}.`),
      { status: 502, code: 'REDIRECTS_FAILED' },
    );
  }

  if (WRITE_ACTIONS.has(action) && res.data?.ok !== false) {
    await logUsage(user.id, 'wp_redirect_write', projectId, project.name, { action });
  }

  // The plugin's own body and status, straight through: it already answers
  // `{ ok, error, message }` for a refusal and `{ ok, rules }` / `{ ok, rows }`
  // for a read, and every refusal here is something the operator can act on.
  return { httpStatus: res.status, ...(res.data || {}) };
}
