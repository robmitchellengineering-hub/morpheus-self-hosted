// Ported from base44/functions/getPublicTemplate/entry.ts.
// PUBLIC function — no auth required. Returns template details for the
// public store page. For free templates, includes the files JSON so the
// frontend can offer a ZIP download. For paid templates, files are withheld
// — they are only released after purchase verification.
import { prisma } from '../db.js';

export default async function handler({ body }) {
  const { templateId } = body || {};
  if (!templateId) throw Object.assign(new Error('templateId required'), { status: 400 });

  // asServiceRole.entities.Template.get(templateId) — no owner filter.
  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) throw Object.assign(new Error('Template not found'), { status: 404 });

  let screenshots = [];
  try {
    screenshots = template.screenshots ? JSON.parse(template.screenshots) : [];
  } catch {
    // ignore malformed screenshots JSON
  }

  const isFree = !template.price || template.price <= 0;

  return {
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
    files: isFree ? (template.files || '') : null,
  };
}
