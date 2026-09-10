// State for the STORE panel: is a WordPress plugin connected, is it healthy,
// and the shop context (categories, brands, currency) for the form's
// dropdowns.
import { prisma } from '../db.js';
import { getWpConnection, wpStatus, wpStore } from '../lib/wpPlugin.js';

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) {
    return { connected: false };
  }

  const status = await wpStatus(conn.siteUrl);
  const online = status.ok && status.data?.plugin === 'morpheus';
  const wooOk = online && status.data?.store?.available;

  let context = null;
  if (wooOk) {
    const ctx = await wpStore(conn, 'context');
    if (ctx.ok && ctx.data?.ok) context = ctx.data;
  }

  return {
    connected: true,
    siteUrl: conn.siteUrl,
    online,
    version: online ? status.data.version : null,
    woocommerce: online ? (status.data?.store?.woocommerce || null) : null,
    store_available: !!wooOk,
    context, // { currency, currency_symbol, categories, brand_taxonomy, brands, default_status }
  };
}
