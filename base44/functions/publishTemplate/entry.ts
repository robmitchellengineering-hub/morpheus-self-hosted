import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { logUsage, detectLanguage } from '../../shared/projectUtils.ts';
import { stripeFetch, encodeForm } from '../../shared/stripeUtils.ts';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId, tags, category, price, screenshots, icon, long_description } = body;
    const templatePrice = Math.max(0, Number(price) || 0);
    if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });
    // Stripe requires checkout totals to convert to at least 50¢ in the
    // account's settlement currency. Reject sub-minimum prices at publish time
    // so buyers never hit a raw Stripe minimum-amount error at checkout.
    const MIN_PRICE = 0.50;
    if (templatePrice > 0 && templatePrice < MIN_PRICE) {
      return Response.json({ error: `Paid templates must cost at least $${MIN_PRICE.toFixed(2)} (Stripe minimum checkout amount). Set the price to 0 to publish for free.` }, { status: 400 });
    }

    const project = await base44.entities.Project.get(projectId);
    if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

    const files = await base44.entities.ProjectFile.filter({ project_id: projectId });
    if (files.length === 0) return Response.json({ error: 'No files to publish' }, { status: 400 });

    const filesMap = files.map((f: any) => ({ path: f.path, content: f.content, language: detectLanguage(f.path) }));

    const template = await base44.entities.Template.create({
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
      long_description: long_description || ''
    });

    let stripePriceId = '';
    if (templatePrice > 0) {
      try {
        const appId = Deno.env.get("BASE44_APP_ID") || '';
        const product = await stripeFetch('/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: encodeForm({
            name: project.name,
            description: (project.description || '').substring(0, 350) || undefined,
            metadata: { base44_app_id: appId, template_id: template.id }
          })
        });
        const priceObj = await stripeFetch('/prices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: encodeForm({
            product: product.id,
            unit_amount: Math.round(templatePrice * 100),
            currency: 'usd',
            metadata: { base44_app_id: appId, template_id: template.id }
          })
        });
        stripePriceId = priceObj.id;
        await base44.entities.Template.update(template.id, { stripe_price_id: stripePriceId });
      } catch (e) {
        console.error('Stripe price creation failed:', e.message);
      }
    }

    await logUsage(base44, 'template_publish', projectId, project.name, { templateId: template.id, fileCount: files.length, price: templatePrice });

    return Response.json({ templateId: template.id, name: template.name, fileCount: files.length, price: templatePrice });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}