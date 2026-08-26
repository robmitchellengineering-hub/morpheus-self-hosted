// Ported from base44/functions/installTemplate/entry.ts.
// Clones a template's files into a new Project for the current user — free
// templates immediately, paid templates only after verifying a Purchase.
import { prisma } from '../db.js';
import { logUsage, detectLanguage } from '../lib/projectUtils.js';

export default async function handler({ user, body, res }) {
  const { templateId, projectName } = body;
  if (!templateId) throw Object.assign(new Error('templateId required'), { status: 400 });

  // Template is a cross-user readable resource (marketplace listing) — no
  // owner filter on the lookup itself, same as the original's plain .get().
  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) throw Object.assign(new Error('Template not found'), { status: 404 });

  // Paid templates require a completed purchase (or ownership)
  if (template.price && template.price > 0 && template.author_id !== user.id) {
    const purchases = await prisma.purchase.findMany({
      where: { template_id: templateId, buyer_id: user.id, status: 'paid' },
    });
    if (purchases.length === 0) {
      // Not a plain error — the frontend reads `requiresPayment`/`price` off
      // this response to kick off checkout, so write it directly rather
      // than through the {error} shape the dispatcher gives thrown errors.
      res.status(402).json({ error: 'Payment required', requiresPayment: true, price: template.price });
      return;
    }
  }

  const name = (projectName || `${template.name} (clone)`).toString().trim();
  const project = await prisma.project.create({
    data: {
      created_by_id: user.id,
      name,
      description: template.description || '',
      status: 'ready',
      compile_target: template.compile_target || 'source',
    },
  });

  let files = [];
  try {
    files = JSON.parse(template.files);
  } catch {
    files = [];
  }
  if (files.length > 0) {
    await prisma.projectFile.createMany({
      data: files.map((f) => ({
        created_by_id: user.id,
        project_id: project.id,
        path: f.path,
        content: f.content || '',
        language: f.language || detectLanguage(f.path),
      })),
    });
  }

  // Increment install count (service-role — the installer isn't the template
  // author, so an owner-scoped update rule would block a user-context call)
  try {
    await prisma.template.update({ where: { id: templateId }, data: { install_count: (template.install_count || 0) + 1 } });
  } catch {
    // non-critical
  }

  await logUsage(user.id, 'template_install', project.id, project.name, { templateId, fileCount: files.length });

  return { projectId: project.id, projectName: project.name, fileCount: files.length };
}
