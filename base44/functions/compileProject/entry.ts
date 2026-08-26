import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { logUsage } from '../../shared/projectUtils.ts';
import { getCompileTarget, listCompileTargets } from '../../shared/compile-targets/index.ts';
import { renderWorkflow } from '../../shared/compile-targets/workflow-renderer.ts';
import { getAppUserGithubToken } from '../../shared/githubConnection.ts';
import { createRepo, pushFiles, ghHeaders, ghJson } from '../../shared/githubPush.ts';

const GH_API = 'https://api.github.com';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId } = body;
    if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });

    const project = await base44.entities.Project.get(projectId);
    const target = project.compile_target || 'source';

    if (target === 'source') {
      return Response.json({ error: 'Source target does not need compilation. Use ZIP export instead.' }, { status: 400 });
    }

    const rawFiles = await base44.entities.ProjectFile.filter({ project_id: projectId });
    if (rawFiles.length === 0) return Response.json({ error: 'No files to compile' }, { status: 400 });

    // Look up the compile target adapter. Each adapter handles its own
    // validation, scaffolding, and build-step generation in isolation.
    const adapter = getCompileTarget(target);
    if (!adapter) {
      return Response.json({
        error: `Unsupported compile target: "${target}". Supported: ${listCompileTargets().join(', ')}`
      }, { status: 400 });
    }

    // Check required secrets before doing any work — fail fast with a clear
    // message instead of letting the build fail 5 minutes in on GitHub Actions.
    if (adapter.requiredSecrets && adapter.requiredSecrets.length > 0) {
      const missing = adapter.requiredSecrets.filter(s => !Deno.env.get(s));
      if (missing.length > 0) {
        return Response.json({
          error: `This compile target requires secrets that are not set: ${missing.join(', ')}. Add them in Settings → Secrets before compiling.`
        }, { status: 400 });
      }
    }

    const projectFiles = rawFiles.map(f => ({ path: f.path, content: f.content }));

    // 1. Validate — does the project have the essential source files?
    const validation = adapter.validate(projectFiles);
    if (!validation.valid) {
      return Response.json({ error: validation.error || 'Project is missing required files for this compile target.' }, { status: 400 });
    }

    // 2. Scaffold — auto-generate missing config files (Gradle, pyproject, etc.)
    const scaffold = adapter.scaffold(projectFiles);
    const files = scaffold.files;

    // 3. Generate structured build steps → render to workflow YAML
    const steps = adapter.buildSteps(files);
    const workflow = renderWorkflow(adapter.runner, steps, adapter.artifact);

    // Dry-run mode: return the build preview (scaffolded files, workflow YAML,
    // artifact spec) without pushing to GitHub. Lets the user catch
    // misconfigurations before wasting a GitHub Actions run.
    if (body.dryRun) {
      return Response.json({
        dryRun: true,
        target,
        label: adapter.label,
        runner: adapter.runner,
        validation: { valid: true, warnings: validation.warnings || [] },
        generatedFiles: scaffold.generated,
        totalFiles: files.length,
        workflow,
        artifact: {
          glob: adapter.artifact.glob,
          isGlob: adapter.artifact.isGlob,
          artifactName: adapter.artifact.artifactName
        }
      });
    }

    let accessToken;
    try {
      accessToken = await getAppUserGithubToken(base44);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    const h = ghHeaders(accessToken);

    // Create repo using shared helper (handles name collisions)
    const slug = project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 20) || 'construct';
    const repoName = `morpheus-build-${slug}-${Date.now()}`;
    const repo = await createRepo(accessToken, repoName, true);
    if (!repo || !repo.full_name) return Response.json({ error: 'Failed to create repository', ghError: repo?.message }, { status: 500 });

    // Push project files + workflow using shared helper (has retry logic for tree creation)
    const allFiles = [
      ...files.map(f => ({ path: f.path, content: f.content })),
      { path: '.github/workflows/build.yml', content: workflow }
    ];
    const { branch } = await pushFiles(accessToken, repo.full_name, allFiles, 'Upload from Morpheus for compilation');

    // Wait for workflow registration, then find it
    let workflowId: number | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(3000);
      const wfRes = await fetch(`${GH_API}/repos/${repo.full_name}/actions/workflows`, { headers: h });
      const wfData = await ghJson(wfRes);
      const wf = (wfData.workflows || []).find((w: any) => w.path === '.github/workflows/build.yml');
      if (wf) { workflowId = wf.id; break; }
    }

    if (!workflowId) {
      return Response.json({ error: 'Build files pushed, but GitHub did not register the workflow in time. Open the repo on GitHub and trigger it manually.', repoUrl: repo.html_url }, { status: 500 });
    }

    // Trigger workflow dispatch
    const dispatchRes = await fetch(`${GH_API}/repos/${repo.full_name}/actions/workflows/${workflowId}/dispatches`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ ref: branch })
    });

    if (!dispatchRes.ok) {
      const err = await ghJson(dispatchRes);
      return Response.json({ error: 'Failed to trigger build', details: err.message || `HTTP ${dispatchRes.status}` }, { status: 500 });
    }

    await logUsage(base44, 'compile', projectId, project.name, { repo: repo.full_name, target });

    return Response.json({
      repoFullName: repo.full_name,
      repoUrl: repo.html_url,
      target,
      status: 'dispatched'
    });
  } catch (error) {
    console.error('Compile error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}