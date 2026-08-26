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

// fileOps: [{ path, content, action: 'create'|'update'|'delete' }]
// existingFiles: current ProjectFile rows (avoids an extra round-trip per op)
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

    if (op.action === 'delete') {
      if (existing) await prisma.projectFile.delete({ where: { id: existing.id } }).catch(() => {});
      appliedOps.push({ path: op.path, action: 'delete' });
      continue;
    }

    if (existing) {
      await prisma.projectFile.update({
        where: { id: existing.id },
        data: { content: op.content || '', language: detectLanguage(op.path) },
      });
    } else {
      const created = await prisma.projectFile.create({
        data: {
          created_by_id: userId,
          project_id: projectId,
          path: op.path,
          content: op.content || '',
          language: detectLanguage(op.path),
        },
      });
      createdIds.set(op.path, created.id);
    }
    appliedOps.push({ path: op.path, action: op.action || 'create' });
  }
  return appliedOps;
}
