// Save a project's form-delivery config — upserts .morpheus/forms.json as a
// ProjectFile so it travels with the project. Morpheus never handles a form
// submission; this is only the delivery contract the coder builds against.
import { prisma } from '../db.js';
import { FORMS_PATH, normalizeForms } from '../lib/projectForms.js';

export default async function handler({ user, body }) {
  const { projectId, forms } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const normalized = normalizeForms(forms);
  const content = JSON.stringify(normalized, null, 2);
  const existing = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: FORMS_PATH } });
  if (existing) {
    await prisma.projectFile.update({ where: { id: existing.id }, data: { content } });
  } else {
    await prisma.projectFile.create({
      data: { project_id: projectId, created_by_id: user.id, path: FORMS_PATH, content, language: 'json' },
    });
  }
  return { forms: normalized };
}
