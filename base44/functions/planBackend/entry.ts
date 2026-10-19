import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { invokeAI } from '../../shared/aiUtils.ts';
import { logUsage } from '../../shared/projectUtils.ts';
import { COMPONENTS, getServiceOption, DEFAULT_COMPONENTS } from '../../shared/infrastructureComponents.ts';

// Analyzes the project's frontend files and generates a backend architecture
// plan (database schema, API routes, auth strategy, storage, env vars) using
// the high-think planner model. The plan is saved as backend/.plan.json.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId } = body;
    if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });

    const project = await base44.entities.Project.get(projectId);
    const files = await base44.entities.ProjectFile.filter({ project_id: projectId });
    const frontendFiles = files.filter(f => !f.path.startsWith('backend/'));
    const isStandalone = project.project_type === 'backend';

    if (!isStandalone && frontendFiles.length === 0) {
      return Response.json({ error: 'No frontend files to analyze. Build the frontend first.' }, { status: 400 });
    }

    const fileSummary = frontendFiles
      .map(f => `--- ${f.path} ---\n${f.content.substring(0, 3000)}`)
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

Available infrastructure components and their free-tier service options:
${COMPONENTS.map(c => `- ${c.type} (${c.label}): ${c.options.map(o => o.id).join(', ')}`).join('\n')}

For each component the backend needs, suggest the best free-tier service and list 1-2 alternatives. Include a reason for each suggestion.

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
        primary: { type: 'boolean' }
      }
    };

    const tableSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        columns: { type: 'array', items: columnSchema }
      }
    };

    const routeSchema = {
      type: 'object',
      properties: {
        method: { type: 'string' },
        path: { type: 'string' },
        description: { type: 'string' }
      }
    };

    const planSchema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        database: {
          type: 'object',
          properties: { tables: { type: 'array', items: tableSchema } }
        },
        api: {
          type: 'object',
          properties: { routes: { type: 'array', items: routeSchema } }
        },
        auth: {
          type: 'object',
          properties: { strategy: { type: 'string' }, details: { type: 'string' } },
          required: ['strategy', 'details']
        },
        storage: {
          type: 'object',
          properties: { type: { type: 'string' }, details: { type: 'string' } }
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
              reason: { type: 'string' }
            },
            required: ['type', 'suggested']
          }
        }
      },
      required: ['summary', 'database', 'api', 'auth', 'storage', 'envVars', 'recommendations', 'components']
    };

    const { result: plan } = await invokeAI(base44, prompt, planSchema, undefined, 'planner');

    // Validate AI-suggested component IDs against the known COMPONENTS list.
    // If the AI hallucinated a service ID, fall back to the default for that
    // component type so deploy doesn't fail later with "Unknown service".
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
    const existingPlan = await base44.entities.ProjectFile.filter({ project_id: projectId, path: 'backend/.plan.json' });
    const planContent = JSON.stringify(plan, null, 2);
    if (existingPlan.length > 0) {
      await base44.entities.ProjectFile.update(existingPlan[0].id, { content: planContent });
    } else {
      await base44.entities.ProjectFile.create({ project_id: projectId, path: 'backend/.plan.json', content: planContent, language: 'json' });
    }

    await logUsage(base44, 'autonomous_step', projectId, project.name, { phase: 'backend_plan' });

    return Response.json({ plan, status: 'planned' });
  } catch (error) {
    console.error('Plan backend error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}