// Ported from base44/shared/projectUtils.ts — credit costs, usage logging,
// language detection, snapshotting, applying AI file operations.
import { prisma } from '../db.js';
import { offloadLargeString } from '../storage.js';

export const CREDIT_COSTS = {
  chat_build: 2,
  chat_simple: 1,
  autonomous_step: 3,
  test_generation: 3,
  github_upload: 2,
  github_import: 2,
  email_export: 1,
  voice_generation: 1,
  zip_export: 1,
  template_publish: 2,
  template_install: 1,
  compile: 2,
  native_prototype: 2,
  diagnosis: 2,
  context_summary: 1, // periodic rolling-memory update, see lib/contextSummary.js
};

export async function logUsage(userId, actionType, projectId, projectName, metadata) {
  const credits = CREDIT_COSTS[actionType] || 1;
  try {
    await prisma.usageRecord.create({
      data: {
        created_by_id: userId,
        action_type: actionType,
        credits,
        project_id: projectId || null,
        project_name: projectName || '',
        metadata: metadata ? JSON.stringify(metadata).substring(0, 2000) : '',
      },
    });
  } catch {
    // usage logging must never break the main operation
  }
}

const LANGUAGE_MAP = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', html: 'html', css: 'css', md: 'markdown', py: 'python',
  sh: 'bash', yml: 'yaml', yaml: 'yaml', txt: 'text', ino: 'cpp', cpp: 'cpp',
  h: 'cpp', java: 'java', kt: 'kotlin', swift: 'swift', go: 'go', rs: 'rust',
  gradle: 'groovy', xml: 'xml',
};

export function detectLanguage(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  return LANGUAGE_MAP[ext] || 'text';
}

export async function createSnapshot(userId, projectId, label) {
  const files = await prisma.projectFile.findMany({ where: { project_id: projectId } });
  const filesMap = files.map((f) => ({ path: f.path, content: f.content }));
  const json = JSON.stringify(filesMap);
  const { value, file_url } = await offloadLargeString(json, `snapshot-${projectId}-${Date.now()}.json`);
  await prisma.fileSnapshot.create({
    data: { created_by_id: userId, project_id: projectId, label, files: value, file_url: file_url || null },
  });
}

// Known binary/compiled-artifact file types the AI cannot author as real
// bytes -- it can only ever produce these as text content. If a fileOp
// targets one of these paths with empty (or whitespace-only) content, the
// LLM has generated a fake placeholder instead of real content. Persisting
// that is worse than not writing the file at all: it looks complete in the
// file tree / ZIP export right up until someone actually tries to use it
// (e.g. the empty gradle-wrapper.jar incident found 2026-09-01 -- Morpheus's
// own compile pipeline silently regenerates a real one, so the fake file
// was invisible until a user opened the raw project). This is a defensive
// backstop alongside the SYSTEM_PROMPT instruction telling the AI not to
// generate these paths at all -- it still guards every project type even if
// a future prompt change forgets to say so, or the model just doesn't obey.
const BINARY_EXTENSIONS = new Set([
  'jar', 'class', 'so', 'dll', 'dylib', 'exe', 'apk', 'aar', 'keystore', 'jks',
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'bmp', 'webp',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'zip', 'gz', 'tar', '7z',
  'wav', 'mp3', 'mp4', 'mov', 'avi',
  'pdf',
]);

function isFakeBinaryPlaceholder(path, content) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (!BINARY_EXTENSIONS.has(ext)) return false;
  return !content || content.trim().length === 0;
}

// fileOps: [{ path, content, action: 'create'|'update'|'delete' }]
// existingFiles: current ProjectFile rows (avoids an extra round-trip per op)
// Apply a list of { find, replace } edits to a string. Returns
// { ok, content, failed } — `failed` lists the edits that didn't apply, and
// on any failure `content` is the ORIGINAL, untouched (a partial diff apply
// is worse than none). Diff-based editing's whole point is that the coder
// only ever touches what it names, so a non-matching `find` must be a
// no-op, never a guess.
//
// Matching is: exact first; then whitespace-tolerant (trailing whitespace
// per line ignored, leading indentation must still match) so the LLM
// reproducing a block with slightly-off trailing spaces still lands. A
// `find` that matches more than once is rejected as ambiguous.
export function applyEdits(original, edits) {
  let content = original;
  const failed = [];
  for (const edit of edits || []) {
    const find = typeof edit?.find === 'string' ? edit.find : '';
    const replace = typeof edit?.replace === 'string' ? edit.replace : '';
    if (!find) { failed.push({ find, reason: 'empty find' }); continue; }

    // exact
    const first = content.indexOf(find);
    if (first !== -1) {
      if (content.indexOf(find, first + 1) !== -1) { failed.push({ find, reason: 'ambiguous — matches more than once' }); continue; }
      content = content.slice(0, first) + replace + content.slice(first + find.length);
      continue;
    }

    // whitespace-tolerant: match the find lines against a window of content
    // lines, ignoring trailing whitespace on each line.
    const norm = (s) => s.replace(/[ \t]+$/gm, '');
    const cLines = content.split('\n');
    const fLines = norm(find).split('\n');
    const nLines = cLines.map(norm);
    let hit = -1;
    for (let i = 0; i + fLines.length <= nLines.length; i++) {
      if (fLines.every((fl, k) => nLines[i + k] === fl)) {
        if (hit !== -1) { hit = -2; break; } // ambiguous
        hit = i;
      }
    }
    if (hit >= 0) {
      const before = cLines.slice(0, hit).join('\n');
      const after = cLines.slice(hit + fLines.length).join('\n');
      content = (before ? before + '\n' : '') + replace + (after ? '\n' + after : '');
      continue;
    }
    failed.push({ find, reason: hit === -2 ? 'ambiguous — matches more than once' : 'not found — the file may differ from what you were shown' });
  }
  return { ok: failed.length === 0, content: failed.length ? original : content, failed };
}

export async function applyFileOperations(userId, projectId, fileOps, existingFiles) {
  const appliedOps = [];
  const seenPaths = new Set();
  const createdIds = new Map();

  for (const op of fileOps) {
    if (!op?.path) continue;
    if (seenPaths.has(op.path)) continue; // de-dup a repeated path from the LLM
    seenPaths.add(op.path);

    const existing =
      existingFiles.find((f) => f.path === op.path) ||
      (createdIds.has(op.path) ? { id: createdIds.get(op.path) } : null);

    if (op.action !== 'delete' && isFakeBinaryPlaceholder(op.path, op.content)) {
      // Don't create a fake empty binary, and don't clobber a real
      // already-existing one with an empty stub either. Leave whatever is
      // there (nothing, or a real file) untouched and just skip this op.
      appliedOps.push({ path: op.path, action: 'skipped_fake_binary' });
      continue;
    }

    if (op.action === 'delete') {
      // No .catch() here — matches how creates/updates below are handled
      // (uncaught, propagates) and matches the original base44 version,
      // which had no local error handling on this delete either. An
      // earlier pass added `.catch(() => {})`, which silently swallowed a
      // failed delete and still reported it to the caller as a successful
      // 'delete' op — meaning the AI chat/build flow (and the user) could
      // be told a file was removed when it actually still exists, with no
      // trace of the real failure in the response or an error log.
      if (existing) await prisma.projectFile.delete({ where: { id: existing.id } });
      appliedOps.push({ path: op.path, action: 'delete' });
      continue;
    }

    // Diff-based update: op carries `edits` (find/replace) instead of full
    // `content`. Apply them against the file's current content; a
    // non-matching edit leaves the file untouched and is reported back so
    // the caller can retry that one file with full content.
    if (op.action === 'update' && Array.isArray(op.edits) && op.edits.length > 0) {
      if (!existing) {
        appliedOps.push({ path: op.path, action: 'edit_failed', reason: 'file does not exist — cannot edit; use action "create"' });
        continue;
      }
      const base = typeof existing.content === 'string'
        ? existing.content
        : (await prisma.projectFile.findUnique({ where: { id: existing.id } }))?.content || '';
      const { ok, content, failed } = applyEdits(base, op.edits);
      if (!ok) {
        appliedOps.push({ path: op.path, action: 'edit_failed', reason: failed.map((f) => f.reason).join('; '), failedCount: failed.length });
        continue;
      }
      await prisma.projectFile.update({
        where: { id: existing.id },
        data: { content, language: detectLanguage(op.path) },
      });
      appliedOps.push({ path: op.path, action: 'update' });
      continue;
    }

    if (existing) {
      await prisma.projectFile.update({
        where: { id: existing.id },
        data: { content: op.content || '', language: detectLanguage(op.path) },
      });
    } else {
      // 2026-09-02: defensive backstop. `existing` above is only as good as
      // the `existingFiles` snapshot the caller passed in -- if that query
      // was stale or (as chatWithMorpheus.js's now-fixed bug did) scoped too
      // narrowly, a path that actually already exists project-wide would
      // reach here and crash the whole call on a Prisma P2002
      // unique-constraint violation ([project_id, path], see schema.prisma),
      // taking down chat/build entirely instead of just this one file. Treat
      // that race the same as an update: on P2002, look the row up for real
      // and update it instead of failing.
      let created;
      try {
        created = await prisma.projectFile.create({
          data: {
            created_by_id: userId,
            project_id: projectId,
            path: op.path,
            content: op.content || '',
            language: detectLanguage(op.path),
          },
        });
      } catch (err) {
        if (err.code === 'P2002') {
          const real = await prisma.projectFile.findUnique({ where: { project_id_path: { project_id: projectId, path: op.path } } });
          if (real) {
            created = await prisma.projectFile.update({
              where: { id: real.id },
              data: { content: op.content || '', language: detectLanguage(op.path) },
            });
          } else {
            throw err; // genuinely not found — rethrow the original error
          }
        } else {
          throw err;
        }
      }
      createdIds.set(op.path, created.id);
    }
    appliedOps.push({ path: op.path, action: op.action || 'create' });
  }
  return appliedOps;
}
