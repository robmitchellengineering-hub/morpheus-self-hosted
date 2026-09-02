// Ported from base44/functions/getSellerStats/entry.ts.
// Real relational DB lets us query Purchases by seller_id directly instead
// of the original's "fetch 500 recent, filter in memory" workaround (Base44
// had no bulk-by-ids filter) — same output shape, cheaper query.
import { prisma } from '../db.js';
import { isMissingArtifactFilesColumn, TEMPLATE_SELECT_WITHOUT_ARTIFACTS } from '../lib/templateCompat.js';

export default async function handler({ user }) {
  let myTemplates;
  try {
    myTemplates = await prisma.template.findMany({
      where: { created_by_id: user.id },
      orderBy: { created_date: 'desc' },
      take: 200,
    });
  } catch (err) {
    if (!isMissingArtifactFilesColumn(err)) throw err;
    // See lib/templateCompat.js — same pre-migration fallback as
    // browseTemplates.js, so the EARN panel doesn't come back empty with
    // no explanation while artifact_files is still missing in this env.
    myTemplates = await prisma.template.findMany({
      where: { created_by_id: user.id },
      orderBy: { created_date: 'desc' },
      take: 200,
      select: TEMPLATE_SELECT_WITHOUT_ARTIFACTS,
    });
  }
  const templateIds = myTemplates.map((t) => t.id);

  const allPurchases = templateIds.length
    ? await prisma.purchase.findMany({ where: { template_id: { in: templateIds } }, orderBy: { created_date: 'desc' } })
    : [];

  const paid = allPurchases.filter((p) => p.status === 'paid');
  const totalSales = paid.length;
  const totalRevenue = paid.reduce((sum, p) => sum + (p.amount || 0), 0);
  const totalPlatformCut = paid.reduce((sum, p) => sum + (p.platform_cut || 0), 0);
  const totalSellerCut = paid.reduce((sum, p) => sum + (p.seller_cut || 0), 0);
  const refunds = allPurchases.filter((p) => p.status === 'refunded').length;

  const perTemplate = {};
  for (const t of myTemplates) {
    perTemplate[t.id] = { name: t.name, sales: 0, revenue: 0, sellerCut: 0, price: t.price || 0, installs: t.install_count || 0 };
  }
  for (const p of paid) {
    if (perTemplate[p.template_id]) {
      perTemplate[p.template_id].sales++;
      perTemplate[p.template_id].revenue += p.amount || 0;
      perTemplate[p.template_id].sellerCut += p.seller_cut || 0;
    }
  }

  const recentSales = allPurchases.slice(0, 20).map((p) => ({
    template_name: p.template_name,
    amount: p.amount,
    seller_cut: p.seller_cut,
    platform_cut: p.platform_cut,
    status: p.status,
    created_date: p.created_date,
  }));

  return {
    templateCount: myTemplates.length,
    totalSales,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalPlatformCut: Math.round(totalPlatformCut * 100) / 100,
    totalSellerCut: Math.round(totalSellerCut * 100) / 100,
    refunds,
    perTemplate,
    recentSales,
  };
}
