// Ported from base44/functions/emailProjectFiles/entry.ts. The frontend
// already uploaded the ZIP via /api/uploads and passes its file_url here —
// this function just emails the download link (matching the original,
// which used Base44's SendEmail integration rather than an attachment).
//
// `runNote` is the export's own verdict (src/lib/exportPromise.js): the command that starts each part,
// or what is still missing. It matters MORE here than on the two download buttons — the recipient gets
// a file in an inbox with no UI to hover, so the one thing they need, "what do I type", has to be in
// the message. It is optional so an older client still works.
import { sendMail } from '../lib/mailer.js';
import { logUsage } from '../lib/projectUtils.js';

export default async function handler({ user, body }) {
  const { fileUrl, projectName, email, runNote } = body;
  if (!fileUrl || !email) throw Object.assign(new Error('fileUrl and email required'), { status: 400 });

  const note = typeof runNote === 'string' && runNote.trim() ? `\n\nHow to run it:\n${runNote.trim()}` : '';

  await sendMail({
    to: email,
    subject: `Morpheus // ${projectName || 'Project'} source files`,
    text: `Your project "${projectName || 'Project'}" is ready for extraction.\n\nDownload the source archive:\n${fileUrl}${note}\n\n---\nBuilt with Morpheus. You own this code. No lock-in. No illusions.`,
  });

  await logUsage(user.id, 'email_export', '', projectName, { email, runNote: Boolean(note) });
  return { sent: true };
}
