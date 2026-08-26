export const CREDIT_COSTS: Record<string, number> = {
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
  diagnosis: 2
};

export async function logUsage(base44: any, actionType: string, projectId?: string, projectName?: string, metadata?: any): Promise<void> {
  const credits = CREDIT_COSTS[actionType] || 1;
  try {
    await base44.entities.UsageRecord.create({
      action_type: actionType,
      credits,
      project_id: projectId || '',
      project_name: projectName || '',
      metadata: metadata ? JSON.stringify(metadata).substring(0, 2000) : ''
    });
  } catch (e) {
    // Usage logging should never break the main operation
  }
}

export function detectLanguage(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', html: 'html', css: 'css', md: 'markdown', py: 'python', sh: 'bash', yml: 'yaml', yaml: 'yaml', txt: 'text', ino: 'cpp', cpp: 'cpp', h: 'cpp', java: 'java', kt: 'kotlin', swift: 'swift', go: 'go', rs: 'rust', gradle: 'groovy', xml: 'xml' };
  return map[ext] || 'text';
}

// Entity string fields have a platform size limit (~16KB). Any large blob
// stored inline will 500 the whole operation. These helpers make the
// offload-to-file pattern generic: pass a string through `offloadLargeString`
// before writing it to an entity field, and read it back with
// `readOffloadedString`. Below the threshold the value stays inline (no
// extra storage call); above it the full content is uploaded and only a
// truncated preview + file_url are kept on the record.

const FIELD_SIZE_LIMIT = 8000;
const PREVIEW_LENGTH = 2000;

export async function offloadLargeString(base44: any, value: string, filename: string, contentType = 'application/json'): Promise<{ value: string; file_url?: string }> {
  if (!value || value.length <= FIELD_SIZE_LIMIT) return { value };
  const blob = new Blob([value], { type: contentType });
  const file = new File([blob], filename, { type: contentType });
  const { file_url } = await base44.integrations.Core.UploadFile({ file });
  return { value: value.substring(0, PREVIEW_LENGTH), file_url };
}

export async function readOffloadedString(record: { value?: string; file_url?: string }): Promise<string> {
  if (record?.file_url) {
    const resp = await fetch(record.file_url);
    if (!resp.ok) throw new Error(`Failed to fetch offloaded string: ${resp.status}`);
    return await resp.text();
  }
  return record?.value || '';
}

export async function createSnapshot(base44: any, projectId: string, label: string): Promise<void> {
  const files = await base44.entities.ProjectFile.filter({ project_id: projectId });
  const filesMap = files.map((f: any) => ({ path: f.path, content: f.content }));
  const json = JSON.stringify(filesMap);
  const { value, file_url } = await offloadLargeString(base44, json, `snapshot-${projectId}-${Date.now()}.json`);
  await base44.entities.FileSnapshot.create({
    project_id: projectId,
    label,
    files: value,
    ...(file_url ? { file_url } : {}),
  });
}

export async function applyFileOperations(base44: any, projectId: string, fileOps: any[], existingFiles: any[]): Promise<any[]> {
  const appliedOps: any[] = [];
  const seenPaths = new Set<string>();
  const createdIds = new Map<string, string>(); // path → id, for dedup of newly created files
  for (const op of fileOps) {
    if (!op.path) continue;
    if (seenPaths.has(op.path)) continue; // skip duplicate path from LLM output
    seenPaths.add(op.path);
    const existing = existingFiles.find((f: any) => f.path === op.path)
      || (createdIds.has(op.path) ? { id: createdIds.get(op.path) } : null);
    if (op.action === 'delete') {
      if (existing) await base44.entities.ProjectFile.delete(existing.id);
      appliedOps.push({ path: op.path, action: 'delete' });
    } else {
      if (existing) {
        await base44.entities.ProjectFile.update(existing.id, { content: op.content || '', language: detectLanguage(op.path) });
      } else {
        const created = await base44.entities.ProjectFile.create({ project_id: projectId, path: op.path, content: op.content || '', language: detectLanguage(op.path) });
        if (created?.id) createdIds.set(op.path, created.id);
      }
      appliedOps.push({ path: op.path, action: op.action || 'create' });
    }
  }
  return appliedOps;
}