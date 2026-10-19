import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const myTemplates = await base44.entities.Template.filter({ author_id: user.id }, '-created_date', 200);
    const templateIds = myTemplates.map(t => t.id);

    let allPurchases: any[] = [];
    if (templateIds.length > 0) {
      // Purchase has no bulk-by-ids filter; fetch recent and filter in memory
      const recent = await base44.entities.Purchase.list('-created_date', 500);
      allPurchases = recent.filter(p => templateIds.includes(p.template_id));
    }

    const totalSales = allPurchases.filter(p => p.status === 'paid').length;
    const totalRevenue = allPurchases
      .filter(p => p.status === 'paid')
      .reduce((sum, p) => sum + (p.amount || 0), 0);
    const totalPlatformCut = allPurchases
      .filter(p => p.status === 'paid')
      .reduce((sum, p) => sum + (p.platform_cut || 0), 0);
    const totalSellerCut = allPurchases
      .filter(p => p.status === 'paid')
      .reduce((sum, p) => sum + (p.seller_cut || 0), 0);
    const refunds = allPurchases.filter(p => p.status === 'refunded').length;

    const perTemplate: Record<string, { name: string; sales: number; revenue: number; sellerCut: number; price: number; installs: number }> = {};
    for (const t of myTemplates) {
      perTemplate[t.id] = {
        name: t.name,
        sales: 0,
        revenue: 0,
        sellerCut: 0,
        price: t.price || 0,
        installs: t.install_count || 0
      };
    }
    for (const p of allPurchases) {
      if (p.status !== 'paid') continue;
      if (perTemplate[p.template_id]) {
        perTemplate[p.template_id].sales++;
        perTemplate[p.template_id].revenue += p.amount || 0;
        perTemplate[p.template_id].sellerCut += p.seller_cut || 0;
      }
    }

    const recentSales = allPurchases
      .sort((a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime())
      .slice(0, 20)
      .map(p => ({
        template_name: p.template_name,
        amount: p.amount,
        seller_cut: p.seller_cut,
        platform_cut: p.platform_cut,
        status: p.status,
        created_date: p.created_date
      }));

    return Response.json({
      templateCount: myTemplates.length,
      totalSales,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalPlatformCut: Math.round(totalPlatformCut * 100) / 100,
      totalSellerCut: Math.round(totalSellerCut * 100) / 100,
      refunds,
      perTemplate,
      recentSales
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}