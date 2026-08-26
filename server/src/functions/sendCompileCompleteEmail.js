// Ported from base44/functions/sendCompileCompleteEmail/entry.ts.
// Notifies the operator that a compile (and its auto-fix loop) has reached a
// terminal state, so they can step away during long builds and be pulled back.
// The recipient is always the authenticated caller's own email — never a
// client-supplied address — so the endpoint can't be used to send mail to
// arbitrary people.
import { sendMail } from '../lib/mailer.js';

export default async function handler({ user, body }) {
  if (!user.email) throw Object.assign(new Error('No email on account'), { status: 400 });

  const projectName = String(body?.projectName || 'your project').slice(0, 100);
  const target = String(body?.target || 'source').slice(0, 50);
  const result = body?.result === 'success' ? 'success' : 'failed';
  const summary = String(body?.summary || '').slice(0, 400);

  const subject = result === 'success'
    ? `✓ Morpheus — ${projectName} build complete`
    : `✗ Morpheus — ${projectName} build needs attention`;

  const text = result === 'success'
    ? [
        `Your ${target} build for "${projectName}" is complete.`,
        '',
        'The compiled package is saved in your project file tree under _compiled/. Open Morpheus to download it.',
        '',
        '— Morpheus',
      ].join('\n')
    : [
        `Your ${target} build for "${projectName}" finished without success.`,
        '',
        summary,
        '',
        'Open Morpheus and check the COMPILE panel, or ask Morpheus in chat to resolve it.',
        '',
        '— Morpheus',
      ].join('\n');

  await sendMail({ to: user.email, subject, text });

  return { ok: true };
}
