import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { logUsage } from '../../shared/projectUtils.ts';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { fileUrl, projectName, email } = body;
    if (!fileUrl || !email) return Response.json({ error: 'fileUrl and email required' }, { status: 400 });

    await base44.asServiceRole.integrations.Core.SendEmail({
      to: email,
      subject: `Morpheus // ${projectName || 'Project'} source files`,
      body: `Your project "${projectName || 'Project'}" is ready for extraction.\n\nDownload the source archive:\n${fileUrl}\n\n---\n_Built with Morpheus. You own this code. No lock-in. No illusions._`
    });

    await logUsage(base44, 'email_export', '', projectName, { email });
    return Response.json({ sent: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}