// Ported from base44/functions/restoreSnapshot/entry.ts.
import { prisma } from '../db.js';
import { readOffloadedString } from '../storage.js';
import { detectLanguage, createSnapshot } from '../lib/projectUtils.js';

export default async function handler({ user, body }) {
  const { snapshotId } = body;
  if (!snapshotId) throw Object.assign(new Error('snapshotId required'), { status: 400 });

  const snapshot = await prisma.fileSnapshot.findFirst({ where: { id: snapshotId, created_by_id: user.id } });
  if (!snapshot) throw Object.assign(new Error('Snapshot not found'), { status: 404 });

  const json = await readOffloadedString({ value: snapshot.files, file_url: snapshot.file_url });
  const files = JSON.parse(json || '[]');

  await createSnapshot(user.id, snapshot.project_id, 'Pre-restore backup');

  await prisma.projectFile.deleteMany({ where: { project_id: snapshot.project_id } });

  for (const f of files) {
    await prisma.projectFile.create({
      data: {
        created_by_id: user.id,
        project_id: snapshot.project_id,
        path: f.path,
        content: f.content,
        language: detectLanguage(f.path),
      },
    });
  }

  return { restored: files.length, projectId: snapshot.project_id };
}
