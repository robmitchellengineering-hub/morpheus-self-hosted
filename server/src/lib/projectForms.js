// Forms delivery (2026-09-09) — where a site's <form> submissions actually
// go. Config lives in the project (.morpheus/forms.json), so it travels with
// export / repo. ZERO CUSTODY: no form submission ever touches Morpheus —
// the generated handler runs on the user's host and delivers to the user's
// own inbox / sheet. This module just hands the coder the delivery contract
// so every <form> it builds is wired up, not decorative.
import { prisma } from '../db.js';

export const FORMS_PATH = '.morpheus/forms.json';

export const FORM_METHODS = ['netlify', 'smtp', 'sheet'];

export const DEFAULT_FORMS = {
  enabled: false,
  email: '',                 // where submissions land (BYO — the operator's address)
  method: 'netlify',         // netlify | smtp | sheet
  thankYouPath: '/thank-you',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeForms(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !!f.enabled,
    email: typeof f.email === 'string' && EMAIL_RE.test(f.email.trim()) ? f.email.trim().slice(0, 200) : '',
    method: FORM_METHODS.includes(f.method) ? f.method : 'netlify',
    thankYouPath: typeof f.thankYouPath === 'string' && /^\/[\w/-]*$/.test(f.thankYouPath) ? f.thankYouPath : '/thank-you',
  };
}

export async function getForms(projectId) {
  try {
    const row = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: FORMS_PATH } });
    if (!row?.content) return null;
    return normalizeForms(JSON.parse(row.content));
  } catch {
    return null;
  }
}

// Per-method setup the operator must do on their side — shown in the FORMS
// panel and (short form) to the coder so it can tell the operator in chat.
export const FORMS_SETUP = {
  netlify: [
    'Nothing to install — Netlify catches submissions from any <form data-netlify="true">.',
    'In Netlify: Site settings → Forms → turn on an email notification to your address.',
  ],
  smtp: [
    'Add to your host\'s environment: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.',
    'Free path: a Gmail account + an "App password" (Google Account → Security → 2-Step Verification → App passwords). SMTP_HOST=smtp.gmail.com, SMTP_PORT=465.',
  ],
  sheet: [
    'Create a Google Sheet, then Extensions → Apps Script; paste a doPost(e) that appends e.parameter to the sheet.',
    'Deploy → New deployment → Web app, "Execute as me", "Anyone" access. Copy the URL.',
    'Set it as SHEET_WEBHOOK_URL in your host\'s environment.',
  ],
};

// The block handed to the planner + coder on a web build when forms are
// configured — the delivery contract every <form> must satisfy.
export function formsPromptBlock(forms) {
  if (!forms || !forms.enabled) return '';
  const to = forms.email || '(the operator has not set a destination email yet — build the form and the handler, and tell them to set it in the FORMS panel)';
  const common = `Every <form> on this site MUST actually deliver — no decorative forms. Include a hidden honeypot field, client-side required-field validation, and on success show an inline confirmation (or redirect to ${forms.thankYouPath}). On error show a retry message. Submissions go to: ${to}.`;

  if (forms.method === 'netlify') {
    return `
FORM DELIVERY — Netlify Forms (no server code):
${common}
Each <form>: method="POST", data-netlify="true", a unique name="…", a hidden <input type="hidden" name="form-name" value="…"> matching it, and the honeypot as <input name="bot-field"> hidden with CSS. Add/keep a netlify.toml. Build a ${forms.thankYouPath} page. Netlify collects submissions automatically; the operator enables the email notification to ${to} in Site settings → Forms.
`;
  }
  if (forms.method === 'smtp') {
    return `
FORM DELIVERY — serverless function + SMTP email:
${common}
Generate a handler that receives the POST, validates, and emails the submission to ${to} using nodemailer over SMTP (process.env.SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM). Path by host: /api/contact.js (Vercel), functions/api/contact.js (Cloudflare Pages), netlify/functions/contact.js (Netlify) — pick from the host config present, default /api/contact.js. Add "nodemailer" to package.json dependencies. Forms POST to that path via fetch (no full-page reload). Reject on a filled honeypot; basic per-IP rate guard. Do NOT hardcode any secret — read them from process.env.
`;
  }
  return `
FORM DELIVERY — serverless function → Google Sheet:
${common}
Generate a handler at /api/contact.js (or the host-appropriate path) that forwards the submission fields to the operator's Google Apps Script Web App (process.env.SHEET_WEBHOOK_URL) as an application/x-www-form-urlencoded POST — the script appends a row to their sheet. Forms POST to /api/contact via fetch. Reject on a filled honeypot. If SMTP_* env is also present, additionally email a copy to ${to}.
`;
}
