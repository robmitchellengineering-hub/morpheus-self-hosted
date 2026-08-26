// Ported from base44/functions/deleteAccount/entry.ts.
//
// The original deleted each entity type individually because Base44 had no
// cascade-delete. Here, every model in prisma/schema.prisma that references
// User already declares `onDelete: Cascade`, so a single `user.delete`
// removes projects, files, chat messages, snapshots, backend configs,
// settings, rebuild docs, usage records, templates, purchases (as buyer),
// and the GitHub connection in one transaction — same end state as the
// original's function, expressed as the DB's own referential integrity
// instead of a manual per-entity sweep.
import { prisma } from '../db.js';

export default async function handler({ user }) {
  const projectCount = await prisma.project.count({ where: { created_by_id: user.id } });

  await prisma.user.delete({ where: { id: user.id } });

  return {
    success: true,
    projectsDeleted: projectCount,
    userRecordDeleted: true,
    message: 'Account and all associated data deleted.',
  };
}
