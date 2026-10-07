// Ported from base44/functions/compileProject/entry.ts.
// Looks up the compile-target adapter, validates/scaffolds the project,
// renders the GitHub Actions workflow, pushes it to a new build repo, and
// triggers a workflow_dispatch run.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { getCompileTarget, listCompileTargets } from '../lib/compile-targets/index.js';
import { hydrateCabinets } from '../lib/cabinetFile.js';
import { renderWorkflow } from '../lib/compile-targets/workflow-renderer.js';
import { renderUserManual, manualDownloads } from '../lib/appUserManual.js';
import { getGithubToken, createRepo, pushFiles, ghHeaders, ghJson } from '../lib/github.js';
import { fetchStoredBytes } from '../storage.js';
import { assessProjectDivergence } from '../lib/repoDivergence.js';
import { repoAhead, compileDivergenceWarning } from '../lib/projectDivergence.js';

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
  // The scaffolder is PURE AND SYNCHRONOUS on purpose — guards, runner scripts and the app all call it, and
  // one that does I/O is one nobody can test. A cabinet lives in storage as bytes, so they are fetched HERE,
  // once, immediately before it runs. A file whose bytes cannot be fetched is left alone with a warning,
  // which makes the compile a gain plugin rather than a failure.
  const hydrated = await hydrateCabinets(projectFiles, { fetchBytes: fetchStoredBytes });
  for (const w of hydrated.warnings) console.warn(`[compile] ${w}`);
  const scaffold = adapter.scaffold(hydrated.files);
  const files = scaffold.files;

  // 3. Generate structured build steps → render to workflow YAML
  //
  // A target may declare `runners(files)` instead of a single `runner` when one
  // machine cannot produce everything it has to ship — mac-app's Python path
  // needs one job per architecture, because PyInstaller cannot cross-build and
  // an Apple-silicon-only disk image is refused outright by an Intel Mac. See
  // macAppRunners(). Targets without the hook are unchanged.
  const runners = typeof adapter.runners === 'function' ? adapter.runners(files) : null;
  const steps = adapter.buildSteps(files);

  // 4. The user manual that travels with the artifact. Generated here, from the project as it is
  // being compiled, and written by the workflow — see lib/appUserManual.js for why it exists and
  // for the rule it is held to (it may not describe anything Morpheus has not read).
  const manual = renderUserManual({
    projectName: project.name,
    target,
    targetLabel: adapter.label,
    files,
    generatedAt: new Date().toISOString().slice(0, 10),
    downloads: manualDownloads({ artifactGlob: adapter.artifact.glob, runners }),
  });
  const workflow = renderWorkflow(runners || adapter.runner, steps, adapter.artifact, manual);

  // Dry-run mode: return the build preview (scaffolded files, workflow YAML,
  // artifact spec) without pushing to GitHub. Lets the user catch
  // misconfigurations before wasting a GitHub Actions run.
  if (body.dryRun) {
    return {
      dryRun: true,
      target,
      label: adapter.label,
      runner: adapter.runner,
      runners,
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

  // Reuse the project's persistent repo (Project.github_repo — set by this
  // same block below the first time a project compiles, or by
  // uploadToGithub.js's manual "push to GitHub") instead of minting a fresh,
  // disposable, never-cleaned-up repo on every single compile. Rob,
  // 2026-09-15: every project should keep one editable, always-current
  // repo, the way web projects already iterate turn-by-turn in chat — see
  // projectUtils.js's syncProjectFilesToGithub for the other half of this.
  let repo = null;
  if (project.github_repo) {
    // Verify it still exists — it could've been deleted outside Morpheus
    // (or by the cleanupBuildRepos.js sweep, back when this field wasn't
    // set yet). Self-heal by falling through to create-a-new-one below
    // rather than failing the whole compile on a stale reference.
    const checkRes = await fetch(`${GH_API}/repos/${project.github_repo}`, { headers: h });
    if (checkRes.ok) {
      repo = { full_name: project.github_repo, _isNewRepo: false };
    } else {
      await prisma.project.update({ where: { id: projectId }, data: { github_repo: null } }).catch(() => {});
    }
  }

  if (!repo) {
    // Create repo using shared helper (handles name collisions). Stable
    // name (no timestamp — this repo is now persistent, reused by every
    // future compile and by chat auto-sync) under its own prefix,
    // PROJECT_REPO_PREFIX, deliberately NOT COMPILE_BUILD_REPO_PREFIX
    // (see .env.example) — keeps cleanupBuildRepos.js's existing
    // "delete any morpheus-build-* repo older than 24h, no per-project
    // awareness" sweep from ever touching a live, persistent project repo.
    const slug = project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 20) || 'construct';
    const prefix = process.env.PROJECT_REPO_PREFIX || 'morpheus-project-';
    const repoName = `${prefix}${slug}-${project.id}`;
    // autoInit:false — this repo name is always fresh (never created
    // before), so there's no existing content to preserve. Skipping
    // auto_init means pushFiles can build the first commit directly
    // instead of racing GitHub's eventual consistency to read back an
    // auto-generated one (see pushFiles' isNewRepo path) — that race was
    // the actual cause of "compile isn't writing to GitHub".
    repo = await createRepo(accessToken, repoName, true, { autoInit: false });
    if (!repo || !repo.full_name) {
      // Surface GitHub's actual reason (e.g. secondary rate limit from
      // repeated compiles, or a real permissions issue) instead of a bare
      // "Failed to create repository" — that generic message with no detail
      // was previously the only thing the user ever saw, making repeated
      // silent compile failures impossible to self-diagnose.
      const ghMsg = repo?.message || (repo?.errors ? JSON.stringify(repo.errors) : null);
      console.error(`[compileProject] createRepo failed for ${repoName}:`, JSON.stringify(repo));
      res.status(500).json({
        error: ghMsg ? `Failed to create repository on GitHub: ${ghMsg}` : 'Failed to create repository on GitHub (no further detail returned)',
        ghError: repo?.message,
      });
      return;
    }
    // Persist immediately (mirrors uploadToGithub.js) so this compile, every
    // future one, and chat's auto-sync all reuse the same repo from here on.
    await prisma.project.update({ where: { id: projectId }, data: { github_repo: repo.full_name } }).catch(() => {});
  }

  // DIVERGENCE WARNING — detection only, and deliberately NOT a block.
  //
  // The push below writes the construct's files over the repo, one way. If
  // something edited the repo directly since the last sync (a manual push, another
  // tool, a session that fixed the app on the repo side), this push is about to
  // overwrite it. Pressing COMPILE is the operator's explicit instruction, so the
  // build still runs — but the overwrite must never be silent. Whether the push
  // itself should become pull-then-push, preserving both sides, is Rob's decision
  // and is named as the follow-up in the PR; this change only reports.
  //
  // 'unknown' (no repo, no token, API failure) and 'in-sync' add nothing: the
  // compile result is exactly what it was before this check existed.
  let divergenceNote = null;
  if (project.github_repo) {
    const divergence = await assessProjectDivergence({ userId: user.id, project, constructFiles: projectFiles });
    if (repoAhead(divergence)) {
      divergenceNote = compileDivergenceWarning(divergence.ahead.length);
      // APPEND, never replace. validation's own warnings keep their place, and the
      // dispatched response stays the single `warnings: validation.warnings || []`
      // expression scripts/verify-compile-artifacts.mjs has always asserted.
      validation.warnings = [...(validation.warnings || []), divergenceNote];
      console.warn(
        `[compileProject] repo ahead of construct (${divergence.state}, ${divergence.reason}) — this push overwrites `
        + `${divergence.ahead.length} file(s) changed directly on ${repo.full_name}: `
        + `${divergence.ahead.slice(0, 20).join(', ')}`
        + `${divergence.ahead.length > 20 ? ` …(+${divergence.ahead.length - 20} more)` : ''}`,
      );
    }
  }

  // Push project files + workflow using shared helper (has retry logic for tree creation)
  const allFiles = [
    ...files.map((f) => ({ path: f.path, content: f.content })),
    { path: '.github/workflows/build.yml', content: workflow },
  ];
  const { branch } = await pushFiles(accessToken, repo.full_name, allFiles, 'Upload from Morpheus for compilation', { isNewRepo: repo._isNewRepo });

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
    // The warnings the dry-run preview has always shown, carried onto the REAL compile. They were
    // computed either way and then dropped here, so the only way to see them was to run a preview
    // first — which is not what someone does when they are trying to get a site live. The divergence
    // note is appended to validation.warnings above, so it travels in this same array and the panel
    // that already renders warnings is where a silent overwrite becomes visible.
    warnings: validation.warnings || [],
  };
}
