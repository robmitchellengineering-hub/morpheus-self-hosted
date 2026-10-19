import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);

    // Auth is optional — public browsing works without login.
    // When authenticated, we include "mine" and "purchased" flags.
    let user: any = null;
    try { user = await base44.auth.me(); } catch {}

    let category = '';
    let query = '';
    try {
      const body = await req.json();
      category = (body.category || '').toString();
      query = (body.q || '').toString().toLowerCase().trim();
    } catch { /* empty body is fine */ }

    const all = await base44.asServiceRole.entities.Template.list('-created_date', 200);
    const purchases = user ? await base44.entities.Purchase.filter({ buyer_id: user.id, status: 'paid' }) : [];
    const purchasedIds = new Set(purchases.map((p: any) => p.template_id));
    let filtered = all;
    if (category && category !== 'all') {
      filtered = filtered.filter((t: any) => (t.category || 'general') === category);
    }
    if (query) {
      filtered = filtered.filter((t: any) =>
        (t.name || '').toLowerCase().includes(query) ||
        (t.description || '').toLowerCase().includes(query) ||
        (t.tags || '').toLowerCase().includes(query)
      );
    }

    const list = filtered.map((t: any) => ({
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
      purchased: purchasedIds.has(t.id) || (user && t.author_id === user.id)
    }));

    const categories = Array.from(new Set(all.map((t: any) => t.category || 'general')));

    return Response.json({ templates: list, categories });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}