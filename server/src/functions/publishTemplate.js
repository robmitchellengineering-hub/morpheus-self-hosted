// Ported from base44/functions/publishTemplate/entry.ts.
import { prisma } from '../db.js';
import { logUsage, detectLanguage } from '../lib/projectUtils.js';
import { stripeFetch, encodeForm } from '../lib/stripe.js';

// Stripe requires checkout totals to convert to at least 50¢ in the
// account's settlement currency. Reject sub-minimum prices at publish time
// so buyers never hit a raw Stripe minimum-amount error at checkout.
const MIN_PRICE = 0.50;

export default async function handler({ user, body }) {
  const { projectId, tags, category, price, screenshots, icon, long_description } = body;
  const templatePrice = Math.max(0, Number(price) || 0);
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (templatePrice > 0 && templatePrice < MIN_PRICE) {
    throw Object.assign(
      new Error(`Paid templates must cost at least $${MIN_PRICE.toFixed(2)} (Stripe minimum checkout amount). Set the price to 0 to publish for free.`),
      { status: 400 },
    );
  }

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const files = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  if (files.length === 0) throw Object.assign(new Error('No files to publish'), { status: 400 });

  const filesMap = files.map((f) => ({ path: f.path, content: f.content, language: detectLanguage(f.path) }));

  const template = await prisma.template.create({
    data: {
      created_by_id: user.id,
      project_id: projectId,
      name: project.name,
      description: project.description || '',
      author_name: user.full_name || user.email || 'anonymous',
      author_id: user.id,
      files: JSON.stringify(filesMap),
      compile_target: project.compile_target || 'source',
      tags: (tags || '').toString().trim(),
      category: (category || 'general').toString().trim() || 'general',
      file_count: files.length,
      price: templatePrice,
      screenshots: screenshots ? JSON.stringify(screenshots) : '',
      icon: icon || '',
      long_description: long_description || '',
    },
  });

  let stripePriceId = '';
  if (templatePrice > 0) {
    try {
      const appId = process.env.BASE44_APP_ID || '';
      const product = await stripeFetch('/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeForm({
          name: project.name,
          description: (project.description || '').substring(0, 350) || undefined,
          metadata: { base44_app_id: appId, template_id: template.id },
        }),
      });
      const priceObj = await stripeFetch('/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeForm({
          product: product.id,
          unit_amount: Math.round(templatePrice * 100),
          currency: 'usd',
          metadata: { base44_app_id: appId, template_id: template.id },
        }),
      });
      stripePriceId = priceObj.id;
      await prisma.template.update({ where: { id: template.id }, data: { stripe_price_id: stripePriceId } });
    } catch (e) {
      console.error('Stripe price creation failed:', e.message);
    }
  }

  await logUsage(user.id, 'template_publish', projectId, project.name, { templateId: template.id, fileCount: files.length, price: templatePrice });

  return { templateId: template.id, name: template.name, fileCount: files.length, price: templatePrice };
}
