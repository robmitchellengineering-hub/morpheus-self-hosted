// Read a project's site/domain config (.morpheus/site.json) + the DNS
// records the operator needs to add for the configured host.
import { prisma } from '../db.js';
import { SITE_PATH, DEFAULT_SITE, SITE_HOSTS, normalizeSite, dnsRecordsFor, tlsNoteFor } from '../lib/projectSite.js';

export default async function handler({ user, body, query }) {
  const projectId = body?.projectId || query?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const row = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: SITE_PATH } });
  let site = DEFAULT_SITE;
  if (row?.content) {
    try { site = normalizeSite(JSON.parse(row.content)); } catch { /* corrupt — defaults */ }
  }

  return {
    site,
    hosts: SITE_HOSTS,
    dnsRecords: dnsRecordsFor(site),
    tlsNote: site.host ? tlsNoteFor(site.host) : '',
    githubRepo: project.github_repo || null,
    isWeb: (project.compile_target || 'source') === 'web-app',
  };
}
