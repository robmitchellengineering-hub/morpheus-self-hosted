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
  // 'partial' is the honest middle: the build succeeded and some compiled
  // files saved, but at least one release asset did not (see
  // saveCompiledArtifacts.js). Reading that as ✓ "build complete" is the defect
  // this is here to stop; reading it as ✗ "finished without success" hides
  // every file that did land.
  //
  // 'save_failed' (2026-10-02) is the same honesty for a save that landed
  // nothing: the BUILD SUCCEEDED and is downloadable from GitHub. Sending that
  // as 'failed' told the operator their build needed attention and pointed at a
  // rebuild of an app that already existed.
  const result = ['success', 'partial', 'save_failed'].includes(body?.result) ? body.result : 'failed';
  const summary = String(body?.summary || '').slice(0, 400);

  const subject = result === 'success'
    ? `✓ Morpheus — ${projectName} build complete`
    : result === 'partial'
      ? `⚠ Morpheus — ${projectName} build finished with missing files`
      : result === 'save_failed'
        ? `⚠ Morpheus — ${projectName} built, but the app could not be saved`
        : `✗ Morpheus — ${projectName} build needs attention`;

  const text = result === 'success'
    ? [
        `Your ${target} build for "${projectName}" is complete.`,
        '',
        'The compiled package is saved in your project file tree under _compiled/. Open Morpheus to download it.',
        '',
        '— Morpheus',
      ].join('\n')
    : result === 'partial'
      ? [
          `Your ${target} build for "${projectName}" succeeded, but not every compiled file was saved.`,
          '',
          summary,
          '',
          'The files that did save are in your project file tree under _compiled/. The rest are on the GitHub release for this build — download them there. You do not need to rebuild.',
          '',
          '— Morpheus',
        ].join('\n')
      : result === 'save_failed'
        ? [
            `Your ${target} build for "${projectName}" succeeded.`,
            '',
            `Morpheus could not copy the compiled app into your project files${summary ? `: ${summary}` : '.'}`,
            '',
            'The build itself is fine. Download it from the GitHub release for this build, or reopen Morpheus and try saving again — you do not need to rebuild.',
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
