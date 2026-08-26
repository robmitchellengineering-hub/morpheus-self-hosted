// Ported from base44/functions/emailProjectFiles/entry.ts. The frontend
// already uploaded the ZIP via /api/uploads and passes its file_url here —
// this function just emails the download link (matching the original,
// which used Base44's SendEmail integration rather than an attachment).
import { sendMail } from '../lib/mailer.js';
import { logUsage } from '../lib/projectUtils.js';

export default async function handler({ user, body }) {
  const { fileUrl, projectName, email } = body;
  if (!fileUrl || !email) throw Object.assign(new Error('fileUrl and email required'), { status: 400 });

  await sendMail({
    to: email,
    subject: `Morpheus // ${projectName || 'Project'} source files`,
    text: `Your project "${projectName || 'Project'}" is ready for extraction.\n\nDownload the source archive:\n${fileUrl}\n\n---\nBuilt with Morpheus. You own this code. No lock-in. No illusions.`,
  });

  await logUsage(user.id, 'email_export', '', projectName, { email });
  return { sent: true };
}
