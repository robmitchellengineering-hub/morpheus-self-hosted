// Ported from base44/functions/browseTemplates/entry.ts.
// PUBLIC function (see PUBLIC_FUNCTIONS in routes/functions.routes.js) —
// public listing/search across ALL users' Templates. `user` may be null.
import { prisma } from '../db.js';

export default async function handler({ user, body }) {
  const category = (body?.category || '').toString();
  const query = (body?.q || '').toString().toLowerCase().trim();

  // asServiceRole.entities.Template.list('-created_date', 200) — no owner filter.
  const all = await prisma.template.findMany({ orderBy: { created_date: 'desc' }, take: 200 });

  const purchases = user
    ? await prisma.purchase.findMany({ where: { buyer_id: user.id, status: 'paid' } })
    : [];
  const purchasedIds = new Set(purchases.map((p) => p.template_id));

  let filtered = all;
  if (category && category !== 'all') {
    filtered = filtered.filter((t) => (t.category || 'general') === category);
  }
  if (query) {
    filtered = filtered.filter(
      (t) =>
        (t.name || '').toLowerCase().includes(query) ||
        (t.description || '').toLowerCase().includes(query) ||
        (t.tags || '').toLowerCase().includes(query),
    );
  }

  const list = filtered.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    author_name: t.author_name,
    icon: t.icon || '',
    compile_target: t.compile_target,
    tags: t.tags,
    category: t.category || 'general',
    install_count: t.install_count || 0,
    file_count: t.file_count || 0,
    price: t.price || 0,
    created_date: t.created_date,
    mine: user ? t.author_id === user.id : false,
    purchased: purchasedIds.has(t.id) || (user ? t.author_id === user.id : false),
    has_artifacts: !!t.artifact_files && t.artifact_files !== '[]',
  }));

  const categories = Array.from(new Set(all.map((t) => t.category || 'general')));

  return { templates: list, categories };
}
