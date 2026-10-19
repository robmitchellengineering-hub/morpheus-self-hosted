import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { aggregateBuildLogs } from '../../shared/buildLogs.ts';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId } = body;
    if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });

    const project = await base44.entities.Project.get(projectId);
    const logs = await aggregateBuildLogs(base44, projectId);

    return Response.json({ logs, projectName: project.name, totalEvents: logs.length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}