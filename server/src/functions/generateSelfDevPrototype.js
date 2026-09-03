// Self-dev's scoped rapid-prototype generator.
//
// Why this exists: PreviewPanel's default web-app preview (buildPreviewHtml,
// src/lib/buildPreviewHtml.js) works by bundling every file the project has
// into a client-side Babel build. That's fine for a small generated app, but
// self-dev's "project" is Morpheus's own ~150+ file monorepo — real routing,
// path aliases (@/...), npm packages (react-router-dom, lucide-react,
// react-resizable-panels, Tailwind...) that the toy in-browser bundler has no
// way to resolve. Feeding it the whole repo doesn't produce a working
// preview, it just burns the browser's CPU re-transpiling ~150 files after
// every single turn before failing with "Cannot resolve module" — exactly
// the "too expensive to replicate the whole of Morpheus" complaint (Rob,
// 2026-09-03).
//
// The fix: don't try to run the real app at all. Ask the LLM for a small,
// self-contained HTML mockup of ONLY the file(s) the most recent turn
// actually touched — same idea as generateNativePrototype.js's "rapid
// prototype" for native targets, just scoped to a diff instead of a whole
// project (native projects are small enough to send in full; Morpheus isn't).
// The caller (PreviewPanel, in self-dev mode) is responsible for deciding
// whether to call this at all — a turn that only touched server/* has no UI
// to preview, so it skips this endpoint entirely and shows a plain
// "backend-only change" message instead, spending nothing.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { logUsage } from '../lib/projectUtils.js';

const SYSTEM_PROMPT = `You are a rapid prototyping engine inside Morpheus, a Matrix-themed AI coding platform (dark background, monospace font, neon-green accents, terminal/hacker aesthetic).

You are shown one or more source files that were JUST CHANGED in Morpheus's own React codebase, in self-dev mode (Morpheus editing itself). Your job is NOT to reproduce the whole Morpheus application — that would require its full routing, auth, API layer and ~150 other files, none of which you have. Instead, produce a single self-contained HTML document that is a FOCUSED, ISOLATED mockup of ONLY what these specific file(s) do: their layout, styling, and interactive/logic flow.

RULES:
1. Output a COMPLETE, self-contained HTML document (<!DOCTYPE html>...</html>). All CSS inline in <style> tags, all JS inline in <script> tags. You may use CDN <script> tags (e.g. unpkg React) if genuinely useful, but plain HTML/CSS/JS is usually enough and loads faster.
2. If the touched file(s) are a UI component: render it (or a reasonable standalone harness around it) with sensible mock/sample data, so its layout, styling and any interactive behavior (clicks, toggles, form input) can actually be tried. Do not build navigation, auth, or any other part of Morpheus around it — mount it in isolation.
3. If the touched file(s) are logic (a function, hook, handler, backend route, utility) rather than a visual component: build a tiny UI harness — inputs, a "run" action, an output panel — that lets the operator exercise that exact logic path and see the result, so they can verify the flow without reading code.
4. Match Morpheus's own visual style where it's evident from the source (dark background #0a0a0a-ish, monospace, neon green #00ff41-ish accents) so the mockup feels like it belongs, but don't invent an entire app shell (no sidebar, no top nav, no other pages) — just the piece being worked on.
5. Stub anything external (API calls, other components not shown, database access) with obvious mock data or a fake async delay — never claim to hit a real endpoint.
6. Keep it honest: if the given file(s) don't have enough for a sensible mockup (pure config, a type definition, a one-line constant), say so plainly in the HTML instead of inventing unrelated UI.
7. Must run standalone inside an iframe sandbox with allow-scripts.
8. Keep it concise — this is a quick scoped mockup, not a polished final product. Skip explanatory comments, don't pad the CSS with unused rules, and don't over-build beyond what's needed to see the piece working. Shorter output means a faster preview.
9. Return ONLY a JSON object with a single "html" key containing the complete HTML document as a string. No markdown fences, no extra text.`;

export default async function handler({ user, body }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });

  const { projectId, paths } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  const wantedPaths = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
  if (wantedPaths.length === 0) throw Object.assign(new Error('paths required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id, project_type: 'self_dev' } });
  if (!project) throw Object.assign(new Error('Self-dev project not found'), { status: 404 });

  // Cap defensively (mirrors generateNativePrototype.js) even though the
  // caller already scopes this to one turn's touched files — a turn could
  // in principle touch a lot of files at once.
  const MAX_FILE_SIZE = 8000;
  const MAX_FILES = 12;

  const files = await prisma.projectFile.findMany({
    where: { project_id: projectId, created_by_id: user.id, path: { in: wantedPaths.slice(0, MAX_FILES) } },
  });
  if (files.length === 0) throw Object.assign(new Error('None of the given paths were found in this project'), { status: 404 });

  const relevantFiles = files.filter((f) => f.content && f.content.length < MAX_FILE_SIZE);
  const truncatedCount = files.length - relevantFiles.length;

  const filesContext = relevantFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')
    || '(the touched file(s) were too large to include — see PATHS below)';

  const prompt = `${SYSTEM_PROMPT}

PATHS TOUCHED THIS TURN: ${wantedPaths.join(', ')}
${truncatedCount > 0 ? `NOTE: ${truncatedCount} of the touched file(s) were too large to include and are omitted below.\n` : ''}
CHANGED FILE CONTENTS:
${filesContext}

Generate the scoped rapid prototype HTML now. Return ONLY a JSON object: { "html": "<!DOCTYPE html>...</html>" }`;

  const response = await invokeAI({
    userId: user.id,
    prompt,
    schema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'Complete self-contained HTML document for the scoped rapid prototype' },
      },
    },
    fileUrls: undefined,
    role: 'planner',
    // 2026-09-03 (Rob: "the rapid preview is anything but rapid"): this call
    // was previously uncapped ("max think power" default in ai.js), so a
    // single non-streamed generation could run to however many tokens the
    // model felt like producing before the request resolved — the single
    // biggest lever on how long the operator stares at a spinner. A scoped
    // mockup of 1-12 small files never legitimately needs more than a few
    // thousand tokens of HTML/CSS/JS, so bounding it turns an open-ended
    // generation into a fast, predictable one. If a mockup is genuinely
    // complex enough to hit this, invokeAI throws OUTPUT_TRUNCATED, which
    // PreviewPanel already surfaces as a retryable error banner.
    maxTokens: 5000,
  });

  let html = response.result.html || '';
  html = html.replace(/^```html?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  await logUsage(user.id, 'self_dev_prototype', projectId, project.name, { fileCount: relevantFiles.length, paths: wantedPaths });

  return { html, fileCount: relevantFiles.length, paths: wantedPaths };
}
