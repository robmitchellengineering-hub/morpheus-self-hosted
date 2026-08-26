// Ported from base44/functions/compileProject/entry.ts.
// Looks up the compile-target adapter, validates/scaffolds the project,
// renders the GitHub Actions workflow, pushes it to a new build repo, and
// triggers a workflow_dispatch run.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { getCompileTarget, listCompileTargets } from '../lib/compile-targets/index.js';
import { renderWorkflow } from '../lib/compile-targets/workflow-renderer.js';
import { getGithubToken, createRepo, pushFiles, ghHeaders, ghJson } from '../lib/github.js';

const GH_API = 'https://api.github.com';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function handler({ user, body, res }) {
  const { projectId } = body;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const target = project.compile_target || 'source';

  if (target === 'source') {
    throw Object.assign(new Error('Source target does not need compilation. Use ZIP export instead.'), { status: 400 });
  }

  const rawFiles = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  if (rawFiles.length === 0) throw Object.assign(new Error('No files to compile'), { status: 400 });

  // Look up the compile target adapter. Each adapter handles its own
  // validation, scaffolding, and build-step generation in isolation.
  const adapter = getCompileTarget(target);
  if (!adapter) {
    throw Object.assign(
      new Error(`Unsupported compile target: "${target}". Supported: ${listCompileTargets().join(', ')}`),
      { status: 400 }
    );
  }

  // Check required secrets before doing any work — fail fast with a clear
  // message instead of letting the build fail 5 minutes in on GitHub Actions.
  if (adapter.requiredSecrets && adapter.requiredSecrets.length > 0) {
    const missing = adapter.requiredSecrets.filter((s) => !process.env[s]);
    if (missing.length > 0) {
      throw Object.assign(
        new Error(`This compile target requires secrets that are not set: ${missing.join(', ')}. Add them in Settings → Secrets before compiling.`),
        { status: 400 }
      );
    }
  }

  const projectFiles = rawFiles.map((f) => ({ path: f.path, content: f.content }));

  // 1. Validate — does the project have the essential source files?
  const validation = adapter.validate(projectFiles);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.error || 'Project is missing required files for this compile target.'), { status: 400 });
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
    return {
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
        artifactName: adapter.artifact.artifactName,
      },
    };
  }

  // getGithubToken already throws a 400 "GitHub not connected" error if the
  // user hasn't linked their account — matches the original's try/catch.
  const accessToken = await getGithubToken(user.id);
  const h = ghHeaders(accessToken);

  // Create repo using shared helper (handles name collisions). Repo name is
  // prefixed with COMPILE_BUILD_REPO_PREFIX (see .env.example) + project id
  // scoping, matching the original's "morpheus-build-<slug>-<timestamp>" shape.
  const slug = project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 20) || 'construct';
  const prefix = process.env.COMPILE_BUILD_REPO_PREFIX || 'morpheus-build-';
  const repoName = `${prefix}${slug}-${Date.now()}`;
  const repo = await createRepo(accessToken, repoName, true);
  if (!repo || !repo.full_name) {
    res.status(500).json({ error: 'Failed to create repository', ghError: repo?.message });
    return;
  }

  // Push project files + workflow using shared helper (has retry logic for tree creation)
  const allFiles = [
    ...files.map((f) => ({ path: f.path, content: f.content })),
    { path: '.github/workflows/build.yml', content: workflow },
  ];
  const { branch } = await pushFiles(accessToken, repo.full_name, allFiles, 'Upload from Morpheus for compilation');

  // Wait for workflow registration, then find it
  let workflowId = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(3000);
    const wfRes = await fetch(`${GH_API}/repos/${repo.full_name}/actions/workflows`, { headers: h });
    const wfData = await ghJson(wfRes);
    const wf = (wfData.workflows || []).find((w) => w.path === '.github/workflows/build.yml');
    if (wf) { workflowId = wf.id; break; }
  }

  if (!workflowId) {
    res.status(500).json({
      error: 'Build files pushed, but GitHub did not register the workflow in time. Open the repo on GitHub and trigger it manually.',
      repoUrl: repo.html_url,
    });
    return;
  }

  // Trigger workflow dispatch —
  // POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
  // body: { ref: <branch> }
  const dispatchRes = await fetch(`${GH_API}/repos/${repo.full_name}/actions/workflows/${workflowId}/dispatches`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ ref: branch }),
  });

  if (!dispatchRes.ok) {
    const err = await ghJson(dispatchRes);
    res.status(500).json({ error: 'Failed to trigger build', details: err.message || `HTTP ${dispatchRes.status}` });
    return;
  }

  await logUsage(user.id, 'compile', projectId, project.name, { repo: repo.full_name, target });

  return {
    repoFullName: repo.full_name,
    repoUrl: repo.html_url,
    target,
    status: 'dispatched',
  };
}
