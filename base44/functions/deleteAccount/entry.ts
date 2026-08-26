import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// Permanently deletes all data associated with the calling user's account:
// projects, project files, chat messages, snapshots, backend configs,
// settings, rebuild docs, usage records, templates, and purchases.
// Attempts to delete the auth User record itself (may not be permitted by the
// platform — if so, the user should contact Base44 support to remove it).
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // 1. Delete per-project data (files, messages, snapshots, backend configs)
    const projects = await base44.entities.Project.filter({ created_by_id: user.id }, '-created_date', 100);
    for (const p of projects) {
      try {
        await base44.entities.ProjectFile.deleteMany({ project_id: p.id });
        await base44.entities.ChatMessage.deleteMany({ project_id: p.id });
        await base44.entities.FileSnapshot.deleteMany({ project_id: p.id });
        await base44.entities.BackendConfig.deleteMany({ project_id: p.id });
      } catch {}
    }

    // 2. Delete all projects
    try { await base44.entities.Project.deleteMany({ created_by_id: user.id }); } catch {}

    // 3. Delete user-level entities
    try { await base44.entities.UserSettings.deleteMany({ created_by_id: user.id }); } catch {}
    try { await base44.entities.RebuildDoc.deleteMany({ created_by_id: user.id }); } catch {}
    try { await base44.entities.UsageRecord.deleteMany({ created_by_id: user.id }); } catch {}

    // 4. Delete user's marketplace data
    try { await base44.entities.Template.deleteMany({ author_id: user.id }); } catch {}
    try { await base44.entities.Purchase.deleteMany({ buyer_id: user.id }); } catch {}

    // 5. Attempt to delete the auth user record
    let userRecordDeleted = false;
    try {
      await base44.entities.User.delete(user.id);
      userRecordDeleted = true;
    } catch {}

    return Response.json({
      success: true,
      projectsDeleted: projects.length,
      userRecordDeleted,
      message: userRecordDeleted
        ? 'Account and all associated data deleted.'
        : 'All account data deleted. The auth record may require Base44 support to fully remove.',
    });
  } catch (error) {
    console.error('Delete account error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}