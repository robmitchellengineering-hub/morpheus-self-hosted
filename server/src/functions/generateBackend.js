// Ported from base44/functions/generateBackend/entry.ts.
//
// Generates production-ready backend code files based on the architecture
// plan and the chosen deployment target. Uses the coder model, then runs the
// review-and-retry pass before committing. Files are saved as ProjectFile
// records with a "backend/" path prefix.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { buildCodegenPrompt, buildEnvVars, selfContainedRequirement } from '../lib/infrastructureComponents.js';
import { logUsage } from '../lib/projectUtils.js';
import { reviewAndRetry } from '../lib/reviewer.js';
import { generateFilesChunked } from '../lib/chunkedFileGen.js';

function detectLanguage(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    js: 'javascript', ts: 'typescript', sql: 'sql', toml: 'toml',
    yml: 'yaml', yaml: 'yaml', json: 'json', md: 'markdown',
    env: 'bash', dockerfile: 'dockerfile',
  };
  return map[ext] || 'text';
}

export default async function handler({ user, body }) {
  const { projectId, components } = body || {};
  if (!projectId || !components) throw Object.assign(new Error('projectId and components required'), { status: 400 });

  const codegenHint = buildCodegenPrompt(components);
  const envVars = buildEnvVars(components);

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const files = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  const planFile = files.find((f) => f.path === 'backend/.plan.json');
  if (!planFile) throw Object.assign(new Error('No backend plan found. Run planning first.'), { status: 400 });

  const plan = JSON.parse(planFile.content);
  const frontendFiles = files.filter((f) => !f.path.startsWith('backend/'));
  const isStandalone = project.project_type === 'backend';
  const fileSummary = frontendFiles
    .map((f) => `--- ${f.path} ---\n${f.content.substring(0, 1500)}`)
    .join('\n\n')
    .substring(0, 15000);

  // The one thing that makes "runs on your own machine" true rather than advertised: a single command
  // that brings the WHOLE thing up. Derived from the components (lib/infrastructureComponents.js) rather
  // than from a posture name, so a stack that needs an account can never be handed this instruction —
  // and so the exact words the model receives are assertable by a guard.
  const runnableRequirement = selfContainedRequirement(components);

  const refSection = frontendFiles.length > 0
    ? `Reference files (for API contract reference — match the fetch/axios calls the frontend makes):\n${fileSummary}`
    : (isStandalone ? 'No reference files provided — generate the backend based on the plan and project description.' : 'No frontend files available.');

  const backendBrief = `You are Morpheus, a backend code generator. Generate production-ready backend code.
${runnableRequirement}

Infrastructure components (generate code that connects ALL of these):
${codegenHint}

Required environment variables: ${envVars.join(', ')}

Backend Plan:
${JSON.stringify(plan, null, 2)}

${refSection}`;

  // 2026-09-03: this used to be a single "generate ALL backend files" call
  // with NO maxTokens set — the same unbounded-multi-file-output shape that
  // caused the chatWithMorpheus OUTPUT_TRUNCATED incident (see that file's
  // comments, and chunkedFileGen.js). Split into a small file-list PLAN call
  // followed by a chunked WRITE pass, same pattern as chatWithMorpheus.js
  // and generateTests.js.
  const planPrompt = `${backendBrief}

Decide which backend files are needed. You do not write file content yet. Include:
- Server entry point and all route handlers
- Database schema / migrations
- Auth middleware
- Config files (package.json, wrangler.toml, docker-compose.yml, Dockerfile, .env.example, etc.)
- README with setup instructions

Respond as JSON: { "plannedFiles": ["string" (path, relative, WITHOUT "backend/" prefix), ...], "summary": "string" }`;

  const planSchema = {
    type: 'object',
    properties: {
      plannedFiles: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['plannedFiles', 'summary'],
  };

  const { result: filePlan } = await invokeAI({ userId: user.id, prompt: planPrompt, schema: planSchema, role: 'planner', maxTokens: 6000 });
  const plannedFiles = Array.isArray(filePlan.plannedFiles) ? filePlan.plannedFiles.filter((p) => typeof p === 'string' && p) : [];
  const summary = filePlan.summary || 'Backend generated.';

  const writePrompt = `You are Morpheus, a backend code generator. Write full, production-ready file content for the requested file(s) only.

${backendBrief}

Keep code concise but complete — no placeholders, no TODOs, no "// implement this". Every file must be fully functional. Return fileOperations with path (relative, WITHOUT "backend/" prefix), FULL content, and action "create".`;

  const { fileOps: rawFileOps } = await generateFilesChunked({
    userId: user.id,
    plannedFiles,
    role: 'coder',
    buildPrompt: (chunk, allPlanned) => {
      if (!chunk) {
        return `${writePrompt}\n\nGenerate ALL backend files needed now — the full set listed above.`;
      }
      return `${writePrompt}\n\nFULL FILE LIST FOR THIS BACKEND (for context only — do not write these now): ${allPlanned.join(', ')}\n\nFOR THIS STEP, implement ONLY these file(s): ${chunk.join(', ')}. Return fileOperations for ONLY these file(s).`;
    },
  });
  let generatedFiles = rawFileOps.map((f) => ({ path: f.path, content: f.content }));

  // ── Reviewer: check the generated backend code before commit, retry on critical issues ──
  if (generatedFiles.length > 0) {
    const fileOps = generatedFiles.map((f) => ({
      path: f.path.startsWith('backend/') ? f.path : `backend/${f.path}`,
      content: f.content,
      action: 'create',
    }));
    const contextBlock = `BACKEND CODE GENERATION\nProject: ${project.name}\n${project.description ? 'Description: ' + project.description : ''}\nCompile target: ${project.compile_target || 'source'}\nComponents: ${JSON.stringify(components)}\n\nBACKEND PLAN:\n${JSON.stringify(plan, null, 2)}`;
    const reviewed = await reviewAndRetry(user.id, fileOps, contextBlock, JSON.stringify(plan, null, 2), writePrompt);
    generatedFiles = reviewed.fileOps.map((op) => ({ path: op.path, content: op.content }));
  }

  // Delete existing backend code files (keep .plan.json). No .catch() here
  // — the original base44 version had no local error handling on this
  // delete either, so a failure propagates and aborts the request instead
  // of silently leaving stale old backend files mixed in with the newly
  // generated set (an earlier pass here added a swallowing `.catch(() => {})`).
  const existingBackend = files.filter((f) => f.path.startsWith('backend/') && f.path !== 'backend/.plan.json');
  for (const f of existingBackend) {
    await prisma.projectFile.delete({ where: { id: f.id } });
  }

  // Save new backend files (dedup by normalized path — the retry path in
  // reviewAndRetry can return both "api/v1/tasks.js" and "backend/api/v1/tasks.js"
  // which map to the same final path)
  const recordByPath = new Map();
  for (const f of generatedFiles) {
    const normalizedPath = f.path.startsWith('backend/') ? f.path : `backend/${f.path}`;
    recordByPath.set(normalizedPath, {
      created_by_id: user.id,
      project_id: projectId,
      path: normalizedPath,
      content: f.content,
      language: detectLanguage(f.path),
    });
  }
  const records = Array.from(recordByPath.values());
  if (records.length > 0) {
    await prisma.projectFile.createMany({ data: records });
  }

  await logUsage(user.id, 'autonomous_step', projectId, project.name, { phase: 'backend_generate', components, fileCount: records.length });

  return { fileCount: records.length, summary, status: 'generated' };
}
