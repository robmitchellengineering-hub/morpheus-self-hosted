import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// Public endpoint — no auth required.
// Returns template details for the public store page.
// For free templates, includes the files JSON so the frontend can offer a ZIP download.
// For paid templates, files are withheld — they are only released after purchase verification.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { templateId } = body;
    if (!templateId) return Response.json({ error: 'templateId required' }, { status: 400 });

    let template;
    try {
      template = await base44.asServiceRole.entities.Template.get(templateId);
    } catch (e) {
      return Response.json({ error: 'Template not found' }, { status: 404 });
    }
    if (!template) return Response.json({ error: 'Template not found' }, { status: 404 });

    let screenshots: string[] = [];
    try { screenshots = template.screenshots ? JSON.parse(template.screenshots) : []; } catch {}

    const isFree = !template.price || template.price <= 0;

    return Response.json({
      id: template.id,
      name: template.name,
      description: template.description || '',
      long_description: template.long_description || '',
      author_name: template.author_name || 'anonymous',
      icon: template.icon || '',
      screenshots,
      compile_target: template.compile_target || 'source',
      tags: template.tags || '',
      category: template.category || 'general',
      install_count: template.install_count || 0,
      file_count: template.file_count || 0,
      price: template.price || 0,
      created_date: template.created_date,
      files: isFree ? (template.files || '') : null
    });
  } catch (error) {
    console.error('getPublicTemplate error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}