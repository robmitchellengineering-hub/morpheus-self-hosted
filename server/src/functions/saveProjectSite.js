// Save a project's site/domain config — upserts .morpheus/site.json as a
// ProjectFile so it travels with the project. Morpheus stores only the
// domain string + host name; the site itself lives on the operator's host.
import { prisma } from '../db.js';
import { SITE_PATH, normalizeSite, dnsRecordsFor, tlsNoteFor } from '../lib/projectSite.js';

export default async function handler({ user, body }) {
  const { projectId, site } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const normalized = normalizeSite(site);
  const content = JSON.stringify(normalized, null, 2);
  const existing = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: SITE_PATH } });
  if (existing) {
    await prisma.projectFile.update({ where: { id: existing.id }, data: { content } });
  } else {
    await prisma.projectFile.create({
      data: { project_id: projectId, created_by_id: user.id, path: SITE_PATH, content, language: 'json' },
    });
  }

  return {
    site: normalized,
    dnsRecords: dnsRecordsFor(normalized),
    tlsNote: normalized.host ? tlsNoteFor(normalized.host) : '',
  };
}
