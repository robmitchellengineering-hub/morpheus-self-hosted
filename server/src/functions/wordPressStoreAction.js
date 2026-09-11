// Run one Store-module action on the connected WordPress plugin —
// create/update a product, set stock, draft a post, read back. The plugin
// does the WooCommerce work; this just signs and forwards.
import { prisma } from '../db.js';
import { getWpConnection, wpStore } from '../lib/wpPlugin.js';
import { logUsage } from '../lib/projectUtils.js';
import { policyIdForUser, assertWithinVelocity } from '../lib/tenantPolicy.js';

const ALLOWED = new Set([
  'context', 'list_products', 'get_product',
  'create_product', 'update_product', 'set_stock', 'create_post',
]);
const WRITE_ACTIONS = new Set(['create_product', 'update_product', 'set_stock', 'create_post']);

export default async function handler({ user, body }) {
  const { projectId, action, data } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!ALLOWED.has(action)) throw Object.assign(new Error(`Unknown store action: ${action}`), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) throw Object.assign(new Error('No WordPress site connected — connect one in the STORE panel first.'), { status: 400 });

  // Plugin tenants: cap write actions per hour so a scripted loop can't
  // flood the shop (no-op for the owner / self-dev).
  if (WRITE_ACTIONS.has(action)) {
    await assertWithinVelocity(user.id, policyIdForUser(user), 'wp_store_write');
  }

  const res = await wpStore(conn, action, data && typeof data === 'object' ? data : {});

  if (res.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502 });
  }

  if (WRITE_ACTIONS.has(action) && res.data?.ok !== false) {
    await logUsage(user.id, 'wp_store_write', projectId, project.name, { action });
  }
  // Pass the plugin's own body + status straight through (it already has a
  // clean { ok, error, message } / { ok, product, ... } shape).
  return { httpStatus: res.status, ...(res.data || {}) };
}
