// Ported from base44/functions/planBackend/entry.ts.
//
// Analyzes the project's frontend files and generates a backend architecture
// plan (database schema, API routes, auth strategy, storage, env vars) using
// the planner model. The plan is saved as backend/.plan.json.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { logUsage } from '../lib/projectUtils.js';
import { COMPONENTS, getServiceOption, DEFAULT_COMPONENTS, getPosture } from '../lib/infrastructureComponents.js';
import { UI_FEEDBACK_PROMPT_BLOCK } from '../lib/uiFeedback.js';

export default async function handler({ user, body }) {
  const { projectId, posture: requestedPosture } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  // The whole-stack choice, when the operator made one. Validated rather than trusted: an unrecognised
  // id is refused instead of being quietly defaulted, because defaulting a mistyped "self-hosted"
  // would put their data in a cloud account they did not ask for. `null` means "let the architect
  // choose", which is the existing behaviour and stays available.
  const posture = requestedPosture ? getPosture(requestedPosture) : null;
  if (requestedPosture && !posture) {
    throw Object.assign(new Error(`Unknown delivery posture "${requestedPosture}". Expected one of: self-hosted, cloud, container.`), { status: 400 });
  }

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const files = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  const frontendFiles = files.filter((f) => !f.path.startsWith('backend/'));
  const isStandalone = project.project_type === 'backend';

  if (!isStandalone && frontendFiles.length === 0) {
    throw Object.assign(new Error('No frontend files to analyze. Build the frontend first.'), { status: 400 });
  }

  const fileSummary = frontendFiles
    .map((f) => `--- ${f.path} ---\n${f.content.substring(0, 3000)}`)
    .join('\n\n')
    .substring(0, 20000);

  const projectContext = isStandalone
    ? `This is a standalone backend project. Project name: "${project.name}". Description: "${project.description || 'No description provided.'}".

${frontendFiles.length > 0 ? `Reference files (external sources provided by the user):\n${fileSummary}` : 'No reference files provided — design the backend based on the project description.'}

Design a complete backend plan based on the project description and any reference files provided.`
    : `Analyze this frontend application and design the backend architecture needed to support it.

Frontend files:
${fileSummary}

Identify what API calls the frontend makes (look for fetch, axios, API base URLs), what data entities it needs, and what authentication it expects. Then design a complete backend plan.`;

  const prompt = `You are Morpheus, a backend architect. ${projectContext}
${UI_FEEDBACK_PROMPT_BLOCK}

Available infrastructure components and their free-tier service options:
${COMPONENTS.map((c) => `- ${c.type} (${c.label}): ${c.options.map((o) => o.id).join(', ')}`).join('\n')}

${posture ? `THE OPERATOR HAS ALREADY CHOSEN WHERE THIS RUNS — plan for exactly this stack and do not substitute a managed service:
${posture.label}: ${posture.summary}
It guarantees: ${posture.guarantee}
Its cost to the operator: ${posture.tradeoff}
Use these components: ${Object.entries(posture.components).map(([t, i]) => `${t}=${i}`).join(', ')}.
List alternatives only from the same posture (a self-contained stack has no managed alternative, so say so rather than offering one).` : 'For each component the backend needs, suggest the best free-tier service and list 1-2 alternatives. Include a reason for each suggestion.'}

Respond as JSON with this exact structure:
{
  "summary": "One-line description of what the backend does",
  "database": { "tables": [{ "name": "string", "columns": [{ "name": "string", "type": "string", "nullable": true, "primary": true }] }] },
  "api": { "routes": [{ "method": "GET|POST|PUT|DELETE", "path": "/api/...", "description": "string" }] },
  "auth": { "strategy": "jwt|session|none|supabase-auth", "details": "string" },
  "storage": { "type": "none|postgres|supabase-storage|cloudflare-r2|local", "details": "string" },
  "envVars": ["DATABASE_URL", "JWT_SECRET"],
  "recommendations": "Which deployment target fits best and why",
  "components": [{ "type": "api_host|database|auth|file_storage|cache", "suggested": "service_id from the options above", "alternatives": ["service_id"], "reason": "why this free-tier service fits" }]
}`;

  const columnSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      type: { type: 'string' },
      nullable: { type: 'boolean' },
      primary: { type: 'boolean' },
    },
  };

  const tableSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      columns: { type: 'array', items: columnSchema },
    },
  };

  const routeSchema = {
    type: 'object',
    properties: {
      method: { type: 'string' },
      path: { type: 'string' },
      description: { type: 'string' },
    },
  };

  const planSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      database: {
        type: 'object',
        properties: { tables: { type: 'array', items: tableSchema } },
      },
      api: {
        type: 'object',
        properties: { routes: { type: 'array', items: routeSchema } },
      },
      auth: {
        type: 'object',
        properties: { strategy: { type: 'string' }, details: { type: 'string' } },
        required: ['strategy', 'details'],
      },
      storage: {
        type: 'object',
        properties: { type: { type: 'string' }, details: { type: 'string' } },
      },
      envVars: { type: 'array', items: { type: 'string' } },
      recommendations: { type: 'string' },
      components: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            suggested: { type: 'string' },
            alternatives: { type: 'array', items: { type: 'string' } },
            reason: { type: 'string' },
          },
          required: ['type', 'suggested'],
        },
      },
    },
    required: ['summary', 'database', 'api', 'auth', 'storage', 'envVars', 'recommendations', 'components'],
  };

  // 2026-09-03 audit: this structured-plan call (tables/routes/auth/storage/
  // components) had no maxTokens — the same shape as the chatWithMorpheus
  // Planner call that turned out to be the actual cause of that incident
  // (see its comments). Capped explicitly rather than left to the
  // provider's undocumented default.
  const { result: plan } = await invokeAI({ userId: user.id, prompt, schema: planSchema, role: 'planner', maxTokens: 12000 });

  // Validate AI-suggested component IDs against the known COMPONENTS list.
  // If the AI hallucinated a service ID, fall back to the default for that
  // component type so deploy doesn't fail later with "Unknown service".
  if (posture) {
    // Stamped onto the plan so generateBackend and the operator's UI read the SAME decision this plan
    // was written for. Without it, the posture lives only in the request that produced the file.
    plan.posture = posture.id;
    plan.components = (plan.components || []).map((c) => ({ ...c, suggested: posture.components[c.type] || c.suggested, reason: c.type in posture.components ? `Chosen by the "${posture.label}" posture.` : c.reason, alternatives: [] }));
    for (const [type, id] of Object.entries(posture.components)) {
      if (!plan.components.some((c) => c.type === type)) plan.components.push({ type, suggested: id, alternatives: [], reason: `Chosen by the "${posture.label}" posture.` });
    }
  }
  if (plan.components && Array.isArray(plan.components)) {
    for (const comp of plan.components) {
      const service = getServiceOption(comp.type, comp.suggested);
      if (!service) {
        comp.suggested = DEFAULT_COMPONENTS[comp.type] || comp.suggested;
        comp.reason = (comp.reason || '') + ' [Note: original suggestion was invalid, fell back to default.]';
      }
    }
  }

  // Save or update plan file
  const existingPlan = files.find((f) => f.path === 'backend/.plan.json');
  const planContent = JSON.stringify(plan, null, 2);
  if (existingPlan) {
    await prisma.projectFile.update({ where: { id: existingPlan.id }, data: { content: planContent } });
  } else {
    await prisma.projectFile.create({
      data: {
        created_by_id: user.id,
        project_id: projectId,
        path: 'backend/.plan.json',
        content: planContent,
        language: 'json',
      },
    });
  }

  await logUsage(user.id, 'autonomous_step', projectId, project.name, { phase: 'backend_plan' });

  return { plan, status: 'planned' };
}
