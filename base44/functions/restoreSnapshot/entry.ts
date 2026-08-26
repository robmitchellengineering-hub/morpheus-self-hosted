import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { detectLanguage, createSnapshot, readOffloadedString } from '../../shared/projectUtils.ts';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { snapshotId } = body;
    if (!snapshotId) return Response.json({ error: 'snapshotId required' }, { status: 400 });

    const snapshot = await base44.entities.FileSnapshot.get(snapshotId);
    const json = await readOffloadedString({ value: snapshot.files, file_url: snapshot.file_url });
    const files = JSON.parse(json || '[]');

    await createSnapshot(base44, snapshot.project_id, 'Pre-restore backup');

    const currentFiles = await base44.entities.ProjectFile.filter({ project_id: snapshot.project_id });
    for (const f of currentFiles) {
      await base44.entities.ProjectFile.delete(f.id);
    }

    for (const f of files) {
      await base44.entities.ProjectFile.create({
        project_id: snapshot.project_id,
        path: f.path,
        content: f.content,
        language: detectLanguage(f.path)
      });
    }

    return Response.json({ restored: files.length, projectId: snapshot.project_id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}