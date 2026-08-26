import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// Notifies the operator that a compile (and its auto-fix loop) has reached a
// terminal state, so they can step away during long builds and be pulled back.
// Runs as the service role for the Core SendEmail integration; the recipient
// is always the authenticated caller's own email — never a client-supplied
// address — so the endpoint can't be used to send mail to arbitrary people.
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!user.email) return Response.json({ error: 'No email on account' }, { status: 400 });

    const body = await req.json().catch(() => ({}));
    const projectName = String(body?.projectName || 'your project').slice(0, 100);
    const target = String(body?.target || 'source').slice(0, 50);
    const result = body?.result === 'success' ? 'success' : 'failed';
    const summary = String(body?.summary || '').slice(0, 400);

    const subject = result === 'success'
      ? `\u2713 Morpheus \u2014 ${projectName} build complete`
      : `\u2717 Morpheus \u2014 ${projectName} build needs attention`;

    const text = result === 'success'
      ? [
          `Your ${target} build for "${projectName}" is complete.`,
          '',
          'The compiled package is saved in your project file tree under _compiled/. Open Morpheus to download it.',
          '',
          '\u2014 Morpheus'
        ].join('\n')
      : [
          `Your ${target} build for "${projectName}" finished without success.`,
          '',
          summary,
          '',
          'Open Morpheus and check the COMPILE panel, or ask Morpheus in chat to resolve it.',
          '',
          '\u2014 Morpheus'
        ].join('\n');

    await base44.asServiceRole.integrations.Core.SendEmail({
      to: user.email,
      subject,
      body: text
    });

    return Response.json({ ok: true });
  } catch (error) {
    console.error('sendCompileCompleteEmail error', error?.message || error);
    return Response.json({ error: error?.message || 'failed' }, { status: 500 });
  }
}