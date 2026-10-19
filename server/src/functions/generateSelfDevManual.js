// "SELF-DEV & ADMIN MANUAL" — Rob, 2026-09-03: "give me a manual for running
// morpheus through self dev and admin that gets updated when anything to do
// with self dev or admin get updated, make it downloadable in the admin
// page." Unlike generateRebuildDoc.js (a static, hand-authored architecture
// dump — a human has to remember to edit it to keep it current), this reads
// the ACTUAL CURRENT CONTENT of the self-dev/admin source files below and
// has an LLM write the operator manual from them, every time it runs. That
// makes "updated when the code changes" true by construction: regenerate it
// and it reflects whatever those files say right now.
//
// Two ways this regenerates:
//  1. Manual — the admin clicks REGENERATE in Admin → Ops Console (the HTTP
//     handler below, trigger: 'manual').
//  2. Automatic — pushSelfDevToGithub.js calls runGenerateSelfDevManual()
//     directly (no HTTP round-trip) right after a successful push, but only
//     if the push actually touched one of SOURCE_FILES below (trigger:
//     'auto:push') — a push that only changed, say, the marketplace ZIP
//     endpoint has nothing to do with self-dev/admin and shouldn't spend an
//     LLM call regenerating a doc that wouldn't change.
import { prisma } from '../db.js';
import crypto from 'node:crypto';
import { invokeAI } from '../ai.js';
import { uploadFile } from '../storage.js';
import { logUsage } from '../lib/projectUtils.js';

// The fixed set of files this manual is built from. Exported so
// pushSelfDevToGithub.js can check "did this push touch anything the manual
// depends on" without duplicating the list. Deliberately a flat, curated
// list (not "everything under src/pages/") — keeping it to the actual
// self-dev/admin surfaces keeps the prompt focused and its size predictable,
// same reasoning as SELF_DEV_ORIENTATION_FILES in chatWithMorpheus.js.
export const SELF_DEV_ADMIN_MANUAL_SOURCES = [
  'src/pages/SelfDev.jsx',
  'src/pages/AdminPanel.jsx',
  'src/components/matrix/PreviewPanel.jsx',
  'src/components/matrix/HistoryPanel.jsx',
  'src/hooks/useWorkspace.js',
  'server/src/functions/pushSelfDevToGithub.js',
  'server/src/functions/importSelfDevRepo.js',
  'server/src/functions/generateSelfDevPrototype.js',
  'server/src/functions/generateSelfDevManual.js',
  'server/src/routes/functions.routes.js',
  'server/src/routes/admin.routes.js',
];

const SYSTEM_PROMPT = `You are writing the operator's manual for Morpheus, a Matrix-themed AI coding platform. The reader is the platform owner/operator (not an end user) — someone technical but who wants a clear, practical guide to actually running Morpheus day to day through two admin-only surfaces: Self-Dev (chatting with Morpheus to edit Morpheus's own codebase) and the Admin Control Panel.

You are shown the CURRENT, REAL source code of every file that makes up these two surfaces. Write ONLY from what that source actually does — never invent a feature, button, tab, or behavior that isn't in the code shown. If something is genuinely unclear from the source, describe it conservatively rather than guessing specifics. This manual will be read as ground truth by the person operating a live production system, so accuracy matters more than completeness.

Write a complete Markdown document with this structure:

# MORPHEUS — SELF-DEV & ADMIN MANUAL

A one-paragraph intro: what these two surfaces are for and how they relate (Self-Dev is how you change Morpheus; Admin is how you monitor/operate it — and they're cross-linked so you can jump between them).

## 1. SELF-DEV — CHANGING MORPHEUS THROUGH CHAT
Walk through the actual workflow in order: opening self-dev, chatting with Morpheus to request a change, what happens to the files (note that nothing reaches GitHub or production until an explicit push — describe exactly what IS and ISN'T touched before that push), reviewing changes, and using the live preview. For the preview, explain its three real states as implemented (idle / backend-only-change / scoped prototype) and why it works this way (it deliberately does NOT try to rebuild the whole app). Cover History/revert (undo the last prompt, or restore any earlier snapshot) as it's actually implemented.

## 2. PUSHING TO PRODUCTION
Explain exactly what the push button does end to end based on the real code — what repo/branch it pushes to, that it's the real production repo (not a staging copy), and how that push actually results in a live deploy (what's already watching that branch and what visibility the UI gives you afterward). Include any caveats the code itself notes (e.g. what the push does or doesn't do with deleted files).

## 3. ADMIN CONTROL PANEL — TAB BY TAB
One subsection per real tab in the code (use their actual on-screen labels). For each, describe what it actually shows and what actions are available, in plain operator language — not a code walkthrough.

## 4. SAFETY & PERMISSIONS
Summarize, from the actual code, what's gated to admin-only, what requires a confirmation step, what's blocked outright (e.g. schema-altering SQL if the DB console blocks it), and what gets logged where.

## 5. TROUBLESHOOTING
A short set of realistic "if you see X, it means Y, do Z" entries grounded in the actual states/errors the code produces (e.g. what an empty preview means, what a stuck/failed deploy status means, where to look for logs).

Use clear prose with occasional short bullet lists only where genuinely helpful (steps, tab lists) — this is a manual to be read and acted on, not a marketing page. No invented screenshots, no fictional menu items. Return ONLY the Markdown document, no commentary before or after it, no markdown code fences wrapping the whole thing.`;

async function loadSelfDevProject(userId) {
  return prisma.project.findFirst({ where: { created_by_id: userId, project_type: 'self_dev' } });
}

// The real work, callable directly (no HTTP round-trip) from
// pushSelfDevToGithub.js's auto-regeneration hook, and from the HTTP handler
// below for the admin's manual REGENERATE click. `trigger` is stored purely
// for operator visibility in the Admin UI ("last updated automatically after
// a push" vs "last updated by hand").
export async function runGenerateSelfDevManual(user, trigger = 'manual') {
  const project = await loadSelfDevProject(user.id);
  if (!project) throw Object.assign(new Error('Self-dev project not found — import it first'), { status: 404 });

  const files = await prisma.projectFile.findMany({
    where: { project_id: project.id, created_by_id: user.id, path: { in: SELF_DEV_ADMIN_MANUAL_SOURCES } },
  });
  if (files.length === 0) throw Object.assign(new Error('None of the manual\'s source files were found in the self-dev workspace — sync from GitHub first'), { status: 404 });

  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  const ordered = SELF_DEV_ADMIN_MANUAL_SOURCES.map((p) => byPath[p]).filter(Boolean);
  const missing = SELF_DEV_ADMIN_MANUAL_SOURCES.filter((p) => !byPath[p]);

  const filesContext = ordered.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');
  const sourceHash = crypto.createHash('sha256').update(filesContext).digest('hex');

  const prompt = `${SYSTEM_PROMPT}

${missing.length > 0 ? `NOTE: these expected source files were not found and are not reflected below: ${missing.join(', ')}\n` : ''}
CURRENT SOURCE:
${filesContext}

Write the manual now, as Markdown only.`;

  const response = await invokeAI({
    userId: user.id,
    prompt,
    schema: { type: 'object', properties: { markdown: { type: 'string', description: 'The complete manual, as a single Markdown document' } } },
    fileUrls: undefined,
    role: 'planner',
    // 2026-09-03 audit: a full admin/self-dev manual generated from source
    // is a single, potentially long document with no cap set at all. Not a
    // multi-file case (chunking doesn't apply to one document), so this
    // just needs a generous explicit ceiling instead of the provider's
    // undocumented default.
    maxTokens: 20000,
  });

  let content = response.result.markdown || '';
  content = content.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  if (!content) throw new Error('Manual generation returned empty content');

  const version = new Date().toISOString();
  const contentSize = content.length;

  const { file_url } = await uploadFile({
    buffer: content,
    filename: `morpheus-self-dev-admin-manual-${version.replace(/[:.]/g, '-')}.md`,
    contentType: 'text/markdown',
  });
  const preview = content.length > 2000 ? content.substring(0, 2000) + '\n\n... [Full manual in file_url]' : content;

  const existing = await prisma.selfDevManual.findFirst({ where: { created_by_id: user.id }, orderBy: { created_date: 'desc' } });
  const doc = existing
    ? await prisma.selfDevManual.update({ where: { id: existing.id }, data: { version, content: preview, content_size: contentSize, file_url, trigger, source_hash: sourceHash } })
    : await prisma.selfDevManual.create({ data: { created_by_id: user.id, version, content: preview, content_size: contentSize, file_url, trigger, source_hash: sourceHash } });

  await logUsage(user.id, 'chat_simple', project.id, 'self-dev-admin-manual', { version, contentSize, trigger });

  return { version, contentSize, docId: doc.id, trigger, sourceChanged: existing?.source_hash !== sourceHash };
}

export default async function handler({ user }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });
  return runGenerateSelfDevManual(user, 'manual');
}
