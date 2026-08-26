import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { invokeAI } from '../../shared/aiUtils.ts';
import { buildCodegenPrompt, buildEnvVars } from '../../shared/infrastructureComponents.ts';
import { logUsage } from '../../shared/projectUtils.ts';
import { reviewAndRetry } from '../../shared/reviewer.ts';

function detectLanguage(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    js: 'javascript', ts: 'typescript', sql: 'sql', toml: 'toml',
    yml: 'yaml', yaml: 'yaml', json: 'json', md: 'markdown',
    env: 'bash', dockerfile: 'dockerfile'
  };
  return map[ext] || 'text';
}

// Generates production-ready backend code files based on the architecture plan
// and the chosen deployment target. Uses the fast coder model. Files are saved
// as ProjectFile records with a "backend/" path prefix.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId, components } = body;
    if (!projectId || !components) return Response.json({ error: 'projectId and components required' }, { status: 400 });

    const codegenHint = buildCodegenPrompt(components);
    const envVars = buildEnvVars(components);

    const project = await base44.entities.Project.get(projectId);
    const files = await base44.entities.ProjectFile.filter({ project_id: projectId });
    const planFile = files.find(f => f.path === 'backend/.plan.json');
    if (!planFile) return Response.json({ error: 'No backend plan found. Run planning first.' }, { status: 400 });

    const plan = JSON.parse(planFile.content);
    const frontendFiles = files.filter(f => !f.path.startsWith('backend/'));
    const isStandalone = project.project_type === 'backend';
    const fileSummary = frontendFiles
      .map(f => `--- ${f.path} ---\n${f.content.substring(0, 1500)}`)
      .join('\n\n')
      .substring(0, 15000);

    const refSection = frontendFiles.length > 0
      ? `Reference files (for API contract reference — match the fetch/axios calls the frontend makes):\n${fileSummary}`
      : (isStandalone ? 'No reference files provided — generate the backend based on the plan and project description.' : 'No frontend files available.');

    const prompt = `You are Morpheus, a backend code generator. Generate production-ready backend code.

Infrastructure components (generate code that connects ALL of these):
${codegenHint}

Required environment variables: ${envVars.join(', ')}

Backend Plan:
${JSON.stringify(plan, null, 2)}

${refSection}

Generate ALL backend files needed. Each file has a path (relative, WITHOUT "backend/" prefix) and full content. Include:
- Server entry point and all route handlers
- Database schema / migrations
- Auth middleware
- Config files (package.json, wrangler.toml, docker-compose.yml, Dockerfile, .env.example, etc.)
- README with setup instructions

Keep code concise but complete — no placeholders, no TODOs, no "// implement this". Every file must be fully functional.

Respond as JSON: { "files": [{ "path": "string", "content": "string" }], "summary": "string" }`;

    const genSchema = {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        summary: { type: 'string' }
      },
      required: ['files', 'summary']
    };

    const { result } = await invokeAI(base44, prompt, genSchema, undefined, 'coder');
    let generatedFiles = result.files || [];

    // ── Reviewer: check the generated backend code before commit, retry on critical issues ──
    if (generatedFiles.length > 0) {
      const fileOps = generatedFiles.map(f => ({
        path: f.path.startsWith('backend/') ? f.path : `backend/${f.path}`,
        content: f.content,
        action: 'create'
      }));
      const contextBlock = `BACKEND CODE GENERATION\nProject: ${project.name}\n${project.description ? 'Description: ' + project.description : ''}\nCompile target: ${project.compile_target || 'source'}\nComponents: ${JSON.stringify(components)}\n\nBACKEND PLAN:\n${JSON.stringify(plan, null, 2)}`;
      const reviewed = await reviewAndRetry(base44, fileOps, contextBlock, JSON.stringify(plan, null, 2), prompt);
      generatedFiles = reviewed.fileOps.map(op => ({ path: op.path, content: op.content }));
    }

    // Delete existing backend code files (keep .plan.json)
    const existingBackend = files.filter(f => f.path.startsWith('backend/') && f.path !== 'backend/.plan.json');
    for (const f of existingBackend) {
      await base44.entities.ProjectFile.delete(f.id);
    }

    // Save new backend files (dedup by normalized path — the retry path in
    // reviewAndRetry can return both "api/v1/tasks.js" and "backend/api/v1/tasks.js"
    // which map to the same final path)
    const recordByPath = new Map<string, any>();
    for (const f of generatedFiles) {
      const normalizedPath = f.path.startsWith('backend/') ? f.path : `backend/${f.path}`;
      recordByPath.set(normalizedPath, {
        project_id: projectId,
        path: normalizedPath,
        content: f.content,
        language: detectLanguage(f.path),
      });
    }
    const records = Array.from(recordByPath.values());
    if (records.length > 0) {
      await base44.entities.ProjectFile.bulkCreate(records);
    }

    await logUsage(base44, 'autonomous_step', projectId, project.name, { phase: 'backend_generate', components, fileCount: records.length });

    return Response.json({ fileCount: records.length, summary: result.summary, status: 'generated' });
  } catch (error) {
    console.error('Generate backend error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}