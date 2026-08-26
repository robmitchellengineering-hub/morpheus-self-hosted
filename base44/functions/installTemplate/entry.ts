import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { logUsage, detectLanguage } from '../../shared/projectUtils.ts';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { templateId, projectName } = body;
    if (!templateId) return Response.json({ error: 'templateId required' }, { status: 400 });

    const template = await base44.entities.Template.get(templateId);
    if (!template) return Response.json({ error: 'Template not found' }, { status: 404 });

    // Paid templates require a completed purchase (or ownership)
    if (template.price && template.price > 0 && template.author_id !== user.id) {
      const purchases = await base44.entities.Purchase.filter({ template_id: templateId, buyer_id: user.id, status: 'paid' });
      if (purchases.length === 0) {
        return Response.json({ error: 'Payment required', requiresPayment: true, price: template.price }, { status: 402 });
      }
    }

    const name = (projectName || `${template.name} (clone)`).toString().trim();
    const project = await base44.entities.Project.create({
      name,
      description: template.description || '',
      status: 'ready',
      compile_target: template.compile_target || 'source'
    });

    let files: any[] = [];
    try { files = JSON.parse(template.files); } catch { files = []; }
    if (files.length > 0) {
      await base44.entities.ProjectFile.bulkCreate(
        files.map((f: any) => ({
          project_id: project.id,
          path: f.path,
          content: f.content || '',
          language: f.language || detectLanguage(f.path)
        }))
      );
    }

    // Increment install count (service role — the installer isn't the template
    // author, so an owner-scoped update rule would block a user-context call)
    try {
      await base44.asServiceRole.entities.Template.update(templateId, { install_count: (template.install_count || 0) + 1 });
    } catch { /* non-critical */ }

    await logUsage(base44, 'template_install', project.id, project.name, { templateId, fileCount: files.length });

    return Response.json({ projectId: project.id, projectName: project.name, fileCount: files.length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}