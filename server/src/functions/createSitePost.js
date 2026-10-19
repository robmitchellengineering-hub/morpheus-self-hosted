// Create ONE draft post on the connected site — the last step of the SEO tab's
// POST flow, and deliberately its own function rather than a call to
// wordPressStoreAction.
//
// WHY THIS EXISTS
//
// The SEO widget scope could generate a blog draft (`generateBlogPost`) and then
// could not publish it: saving the draft went through `wordPressStoreAction`,
// which lives in the `store` scope, so an SEO-only embed composed a post and got
// `403 Widget tokens can't call wordPressStoreAction` at the final click. A dead
// end in the UI, and one the owner hits after writing the whole thing.
//
// The obvious fix — add wordPressStoreAction to the `seo` scope — would hand an
// SEO-only embed the entire store surface, including `delete_product` and
// `delete_page`. The scope map is function-granular, so least privilege means a
// narrow function instead: this one performs exactly one plugin action, and it
// forces `status: 'draft'` so nothing it creates can appear on the live site
// unseen. Publishing stays an owner action in wp-admin (or the store scope).
import { prisma } from '../db.js';
import { getWpConnection, wpStore } from '../lib/wpPlugin.js';
import { logUsage } from '../lib/projectUtils.js';
import { policyIdForUser, assertWithinVelocity } from '../lib/tenantPolicy.js';

// The plugin's own ceiling; refusing here gives a clear message rather than a
// truncated post.
const MAX_TITLE = 300;
const MAX_CONTENT = 200000;

export default async function handler({ user, body }) {
  const { projectId } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const title = String(body?.title || '').trim();
  if (!title) throw Object.assign(new Error('title required'), { status: 400 });
  if (title.length > MAX_TITLE) throw Object.assign(new Error(`Title is longer than ${MAX_TITLE} characters.`), { status: 400 });

  const content = String(body?.content || '');
  if (!content.trim()) throw Object.assign(new Error('content required'), { status: 400 });
  if (content.length > MAX_CONTENT) throw Object.assign(new Error('That post is too large to send.'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) throw Object.assign(new Error('No WordPress site connected — connect one in the WEBSITE panel first.'), { status: 400 });

  // Plugin tenants: a scripted loop must not be able to flood the site's drafts.
  await assertWithinVelocity(user.id, policyIdForUser(user), 'wp_store_write');

  const res = await wpStore(conn, 'create_post', {
    title,
    content,
    excerpt: body?.excerpt ? String(body.excerpt) : undefined,
    // Never taken from the caller: a draft for review is what this function is
    // for, and a widget-scoped write should not be able to publish.
    status: 'draft',
  });
  if (res.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502 });
  }
  if (res.data?.ok !== false) {
    await logUsage(user.id, 'wp_store_write', projectId, project.name, { action: 'create_post' });
  }
  return { httpStatus: res.status, ...(res.data || {}) };
}
