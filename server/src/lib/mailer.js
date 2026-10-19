// Thin nodemailer wrapper. When SMTP isn't configured, mail is logged to
// the console instead of failing the request — self-host should work with
// zero config out of the box; wire up SMTP_* when you want real delivery.
import nodemailer from 'nodemailer';

let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export async function sendMail({ to, subject, text, html, attachments }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[mailer] (no SMTP configured, not sent) To: ${to} | Subject: ${subject}\n${text || ''}`);
    return { sent: false };
  }
  await t.sendMail({ from: process.env.SMTP_FROM || 'Morpheus <no-reply@localhost>', to, subject, text, html, attachments });
  return { sent: true };
}
