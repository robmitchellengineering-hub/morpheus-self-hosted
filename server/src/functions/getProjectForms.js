// Read a project's form-delivery config (.morpheus/forms.json).
import { prisma } from '../db.js';
import { FORMS_PATH, DEFAULT_FORMS, FORM_METHODS, FORMS_SETUP, normalizeForms } from '../lib/projectForms.js';

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const row = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: FORMS_PATH } });
  let forms = DEFAULT_FORMS;
  if (row?.content) {
    try { forms = normalizeForms(JSON.parse(row.content)); } catch { /* corrupt — defaults */ }
  }
  return { forms, methods: FORM_METHODS, setup: FORMS_SETUP, isWeb: (project.compile_target || 'source') === 'web-app' };
}
