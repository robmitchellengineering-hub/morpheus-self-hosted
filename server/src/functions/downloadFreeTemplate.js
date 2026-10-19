// Server-side ZIP builder for FREE marketplace templates (price = 0), the
// free-download counterpart to downloadTemplate.js (which handles paid
// templates after purchase verification). Both end up building the exact
// same kind of archive — source files plus any attached compiled binaries
// under `_compiled/` — so the logic here mirrors downloadTemplate.js's ZIP
// assembly.
//
// Why this exists instead of the frontend just fetching everything itself:
// StoreItem.jsx used to build the free-template ZIP entirely client-side —
// JSZip in the browser, fetching each artifact's `file_url` (an
// R2/S3-backed cdn.morpheus.nz URL) directly. That works fine for the
// template's own `files` (inline JSON, no network fetch needed) but the
// compiled-artifact fetch is a genuine cross-origin request from
// morpheus.nz to cdn.morpheus.nz, and that storage origin doesn't send
// Access-Control-Allow-Origin — so the browser's fetch() always rejected
// with "TypeError: Failed to fetch", silently caught by StoreItem.jsx's
// try/catch. The buyer got a real ZIP (no error shown) that just never
// contained `_compiled/*` — exactly the "all I can download is the source"
// report, even though publishTemplate.js/getPublicTemplate.js/the DB all
// had the artifact correctly attached the whole time.
//
// Fetching the same file_url from Node (downloadFile() in storage.js, via
// server-side `fetch`) isn't subject to browser CORS at all, so building
// the ZIP here — same as the already-working paid path — sidesteps the
// problem entirely rather than requiring a CORS policy change on the
// storage bucket.
import JSZip from 'jszip';
import { prisma } from '../db.js';
import { downloadFile } from '../storage.js';

export default async function handler({ body, res }) {
  const { templateId } = body || {};
  if (!templateId) throw Object.assign(new Error('templateId required'), { status: 400 });

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) throw Object.assign(new Error('Template not found'), { status: 404 });
  if (template.price && template.price > 0) {
    // Paid templates go through downloadTemplate.js after checkout — this
    // endpoint is public (no auth/purchase check), so it must never hand
    // out a paid listing's files.
    throw Object.assign(new Error('This construct requires purchase — use the BUY flow'), { status: 403 });
  }

  // Increment install count (non-critical) — matches downloadTemplate.js's
  // and installTemplate.js's existing behavior of counting a get/install.
  try {
    await prisma.template.update({ where: { id: templateId }, data: { install_count: (template.install_count || 0) + 1 } });
  } catch (e) {
    console.error('downloadFreeTemplate: install_count increment failed:', e.message);
  }

  let files = [];
  try {
    files = JSON.parse(template.files || '[]');
  } catch {
    files = [];
  }

  const zip = new JSZip();
  for (const f of files) {
    if (!f?.path) continue;
    zip.file(f.path, f.content || '');
  }

  let artifacts = [];
  try {
    artifacts = template.artifact_files ? JSON.parse(template.artifact_files) : [];
  } catch {
    artifacts = [];
  }
  for (const a of artifacts) {
    if (!a?.file_url || !a?.name) continue;
    try {
      const buf = await downloadFile(a.file_url);
      if (buf) zip.file(`_compiled/${a.name}`, buf);
    } catch (e) {
      console.error(`downloadFreeTemplate: failed to bundle compiled artifact ${a.name}:`, e.message);
      // Non-fatal — buyer still gets the source even if a binary fetch fails
    }
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  const safeName = (template.name || 'template').replace(/[^a-zA-Z0-9._-]/g, '_');
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${safeName}.zip"`);
  res.send(buffer);
}
