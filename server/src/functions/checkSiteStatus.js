// On-demand live check of a project's production domain — DNS, HTTPS, TLS
// cert expiry, apex/www redirect. Nothing is stored; this is a snapshot the
// operator triggers from the DOMAIN panel.
import { prisma } from '../db.js';
import { SITE_PATH, normalizeSite } from '../lib/projectSite.js';
import { checkSite } from '../lib/siteStatus.js';

export default async function handler({ user, body }) {
  const { projectId, domain: overrideDomain } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  let domain = '';
  let canonical = 'apex';
  const row = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: SITE_PATH } });
  if (row?.content) {
    try { const s = normalizeSite(JSON.parse(row.content)); domain = s.domain; canonical = s.canonical; } catch { /* */ }
  }
  if (overrideDomain) {
    const s = normalizeSite({ domain: overrideDomain });
    if (s.domain) domain = s.domain;
  }
  if (!domain) throw Object.assign(new Error('No domain set for this project — add one in the DOMAIN panel first.'), { status: 400 });

  return checkSite(domain, canonical);
}
