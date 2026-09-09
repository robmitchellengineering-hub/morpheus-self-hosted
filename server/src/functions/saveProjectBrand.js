// Save a project's brand kit — upserts .morpheus/brand.json as a ProjectFile
// so it travels with the project (export / import / repo). Nothing is stored
// in Morpheus's DB beyond the file row itself. See lib/projectBrand.js.
import { prisma } from '../db.js';
import { BRAND_PATH, normalizeBrand } from '../lib/projectBrand.js';

export default async function handler({ user, body }) {
  const { projectId, brand } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const normalized = normalizeBrand(brand);
  const content = JSON.stringify(normalized, null, 2);

  const existing = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: BRAND_PATH } });
  if (existing) {
    await prisma.projectFile.update({ where: { id: existing.id }, data: { content } });
  } else {
    await prisma.projectFile.create({
      data: { project_id: projectId, created_by_id: user.id, path: BRAND_PATH, content, language: 'json' },
    });
  }
  return { brand: normalized };
}
