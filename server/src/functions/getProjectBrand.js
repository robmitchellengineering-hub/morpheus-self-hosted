// Read a project's brand kit (.morpheus/brand.json). Returns the normalized
// brand + whether one has been set. See lib/projectBrand.js.
import { prisma } from '../db.js';
import { BRAND_PATH, DEFAULT_BRAND, BRAND_FONTS, normalizeBrand, isDefaultBrand } from '../lib/projectBrand.js';

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const row = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: BRAND_PATH } });
  let brand = DEFAULT_BRAND;
  let set = false;
  if (row?.content) {
    try { brand = normalizeBrand(JSON.parse(row.content)); set = !isDefaultBrand(brand); }
    catch { /* corrupt file — fall back to defaults */ }
  }
  return { brand, set, fonts: BRAND_FONTS, isWeb: (project.compile_target || 'source') === 'web-app' };
}
