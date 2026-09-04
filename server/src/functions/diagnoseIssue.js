// Ported from base44/functions/diagnoseIssue/entry.ts.
//
// Unified Morpheus diagnosis agent. Analyzes errors across the entire
// platform (deploy, compile, github, build), auto-fixes code-level issues
// by regenerating broken files with error context, and returns a structured
// action plan for remaining issues that need user action.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { logUsage } from '../lib/projectUtils.js';
import { getServiceOption } from '../lib/infrastructureComponents.js';
import { isCredentialError, isAuthError, buildCredentialAction, applyFileFixes, fixResponseSchema } from '../lib/diagnosis.js';
import { reviewAndRetry } from '../lib/reviewer.js';

export default async function handler({ user, body }) {
  const { type, projectId, errorContext, components } = body || {};
  if (!type || !projectId) throw Object.assign(new Error('type and projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  // 2026-09-04: was scoped by `created_by_id` in addition to `project_id`.
  // ProjectFile's real uniqueness constraint is [project_id, path] — NOT
  // scoped by who created the file — so this filter could silently miss
  // files that exist in the project but were created under a different
  // user/session. applyFileFixes() (lib/diagnosis.js) uses this array to
  // decide update() vs create() per path; missing a file here means it
  // wrongly takes the create() branch and throws Prisma P2002 (unique
  // constraint on [project_id, path]). Same bug already fixed in
  // chatWithMorpheus.js and autonomousBuildStep.js on 2026-09-02 — this
  // call site was missed then. Confirmed via production logs: this exact
  // P2002 crash was hitting diagnoseCompile's auto-fix path.
  const files = await prisma.projectFile.findMany({ where: { project_id: projectId } });

  let diagnosis;

  switch (type) {
    case 'deploy':
      diagnosis = await diagnoseDeploy(user.id, projectId, project, files, errorContext, components);
      break;
    case 'compile':
      diagnosis = await diagnoseCompile(user.id, projectId, project, files, errorContext);
      break;
    case 'github':
      diagnosis = await diagnoseGithub(user.id, projectId, project, files, errorContext);
      break;
    case 'build':
      diagnosis = await diagnoseBuild(user.id, projectId, project, files, errorContext);
      break;
    default:
      throw Object.assign(new Error(`Unknown issue type: ${type}`), { status: 400 });
  }

  await logUsage(user.id, 'diagnosis', projectId, project.name, {
    phase: `diagnose_${type}`,
    diagnosisType: type,
    summary: diagnosis.summary,
    allClear: diagnosis.allClear,
    autoFixed: diagnosis.autoFixed.map((f) => ({ component: f.component, issue: f.issue, fix: f.fix, fileCount: f.fileCount })),
    needsAction: diagnosis.needsUserAction.map((a) => ({ component: a.component, label: a.label, issue: a.issue, severity: a.severity })),
  });

  return { diagnosis };
}

// ─── DEPLOY ──────────────────────────────────────────────────────────────────
async function diagnoseDeploy(userId, projectId, project, files, deployResults, components) {
  const planFile = files.find((f) => f.path === 'backend/.plan.json');
  const plan = planFile ? JSON.parse(planFile.content) : null;
  const backendFiles = files.filter((f) => f.path.startsWith('backend/') && f.path !== 'backend/.plan.json' && f.path !== 'backend/.deploy.json');

  const errorResults = (deployResults || []).filter((r) => r.status === 'error');
  const manualResults = (deployResults || []).filter((r) => r.status === 'zip' || r.status === 'sql-ready');

  const needsUserAction = [];
  const codeErrors = [];

  for (const r of errorResults) {
    const service = getServiceOption(r.component, r.service);
    if (isCredentialError(r.message)) {
      needsUserAction.push(buildCredentialAction(r.component, service?.label || r.service));
    } else {
      codeErrors.push(r);
    }
  }

  for (const r of manualResults) {
    const service = getServiceOption(r.component, r.service);
    if (r.status === 'zip') {
      needsUserAction.push({
        component: r.component, label: service?.label || r.service,
        issue: 'Requires manual ZIP deployment',
        steps: [
          'Download the ZIP package',
          `Upload to ${service?.label || r.service} dashboard`,
          'Configure environment variables on the platform',
          'Verify the deployment is live via the dashboard URL'
        ],
        link: r.url, severity: 'manual'
      });
    } else if (r.status === 'sql-ready') {
      needsUserAction.push({
        component: r.component, label: service?.label || r.service,
        issue: 'SQL migration needs manual execution',
        steps: [
          'Open the SQL editor link in the results above',
          'Paste the provided SQL migration',
          'Run it to create your database tables',
          'Return here and click REDEPLOY to verify'
        ],
        link: r.url, severity: 'manual'
      });
    }
  }

  const autoFixed = await autoFixCodeErrors(userId, projectId, backendFiles, codeErrors, plan, components, 'backend');

  const allClear = autoFixed.length === codeErrors.length && needsUserAction.length === 0 && errorResults.length === 0;
  return {
    summary: allClear ? 'All errors resolved. Click REDEPLOY to go live.'
      : `${autoFixed.length} issue(s) auto-fixed, ${needsUserAction.length} need your action.`,
    autoFixed, needsUserAction,
    totalErrors: errorResults.length + manualResults.length, allClear
  };
}

// ─── COMPILE ─────────────────────────────────────────────────────────────────
async function diagnoseCompile(userId, projectId, project, files, errorContext) {
  const { error, logs, repoUrl, target } = errorContext || {};
  const sourceFiles = files.filter((f) => !f.path.startsWith('backend/') && !f.path.startsWith('external/'));

  const needsUserAction = [];
  const codeErrors = [];

  if (isAuthError(error)) {
    needsUserAction.push({
      component: 'github', label: 'GitHub Connection',
      issue: 'GitHub account not connected',
      steps: [
        'Go to Settings → Connections',
        'Connect your GitHub account',
        'Return here and click COMPILE again'
      ],
      link: '/settings', severity: 'credentials'
    });
  }

  // Build/compile errors are code-level — attempt auto-fix
  if (error && !isAuthError(error)) {
    codeErrors.push({ component: 'compile', service: target, error, logs });
  }

  const autoFixed = await autoFixCodeErrors(userId, projectId, sourceFiles, codeErrors, null, null, 'compile', errorContext);

  if (repoUrl && autoFixed.length === 0) {
    needsUserAction.push({
      component: 'compile', label: target || 'build',
      issue: 'Build failed on GitHub Actions',
      steps: [
        'Open the GitHub Actions run logs (link below)',
        'Identify the failing step and error message',
        'Fix the source file causing the failure, or click AI DIAGNOSE to auto-fix',
        'Click COMPILE again to retry'
      ],
      link: repoUrl, severity: 'external'
    });
  }

  const allClear = autoFixed.length > 0 && needsUserAction.length === 0;
  return {
    summary: allClear ? 'All errors auto-fixed. Click COMPILE to rebuild.'
      : `${autoFixed.length} issue(s) auto-fixed, ${needsUserAction.length} need your action.`,
    autoFixed, needsUserAction,
    totalErrors: codeErrors.length, allClear
  };
}

// ─── GITHUB ──────────────────────────────────────────────────────────────────
async function diagnoseGithub(userId, projectId, project, files, errorContext) {
  const { error, repoName } = errorContext || {};
  const needsUserAction = [];
  const codeErrors = [];

  if (isAuthError(error)) {
    needsUserAction.push({
      component: 'github', label: 'GitHub Connection',
      issue: 'GitHub account not connected',
      steps: [
        'Go to Settings → Connections',
        'Connect your GitHub account',
        'Return here and retry the push'
      ],
      link: '/settings', severity: 'credentials'
    });
  } else if (error?.includes('already exists') || error?.includes('name already')) {
    needsUserAction.push({
      component: 'github', label: 'Repository',
      issue: 'Repository name already exists on your account',
      steps: [
        'Choose a different repository name, or',
        'Delete the existing repo on GitHub first',
        'Retry the push'
      ],
      link: 'https://github.com/new', severity: 'manual'
    });
  } else if (error?.includes('rate limit') || error?.includes('403')) {
    needsUserAction.push({
      component: 'github', label: 'GitHub API',
      issue: 'GitHub API rate limit hit',
      steps: [
        'Wait a few minutes for the rate limit to reset',
        'If persistent, check your GitHub API usage',
        'Retry the push later'
      ],
      link: 'https://docs.github.com/en/rest/overview/resources-in-the-rest-api', severity: 'manual'
    });
  } else if (error) {
    codeErrors.push({ component: 'github', error, repoName });
  }

  // GitHub push errors rarely auto-fix code, but if it's a file-level issue we try
  const autoFixed = [];

  const allClear = autoFixed.length === codeErrors.length && needsUserAction.length === 0 && !error;
  return {
    summary: allClear ? 'All issues resolved. Retry the push.'
      : `${autoFixed.length} issue(s) auto-fixed, ${needsUserAction.length} need your action.`,
    autoFixed, needsUserAction,
    totalErrors: error ? 1 : 0, allClear
  };
}

// ─── BUILD (autonomous) ───────────────────────────────────────────────────────
async function diagnoseBuild(userId, projectId, project, files, errorContext) {
  const { error, step, spec } = errorContext || {};
  const sourceFiles = files.filter((f) => !f.path.startsWith('backend/') && !f.path.startsWith('external/'));

  const needsUserAction = [];
  const codeErrors = [];

  if (error) {
    codeErrors.push({ component: 'build', error, step, spec });
  }

  const autoFixed = await autoFixCodeErrors(userId, projectId, sourceFiles, codeErrors, null, null, 'build', errorContext);

  const allClear = autoFixed.length > 0 && needsUserAction.length === 0;
  return {
    summary: allClear ? 'All errors auto-fixed. Restart the autonomous build.'
      : `${autoFixed.length} issue(s) auto-fixed, ${needsUserAction.length} need your action.`,
    autoFixed, needsUserAction,
    totalErrors: codeErrors.length, allClear
  };
}

// ─── SHARED AUTO-FIX ──────────────────────────────────────────────────────────
async function autoFixCodeErrors(userId, projectId, projectFiles, codeErrors, plan, components, contextType, errorContext) {
  if (codeErrors.length === 0 || projectFiles.length === 0) return [];

  const fileContext = projectFiles
    .map((f) => `--- ${f.path} ---\n${f.content.substring(0, 2000)}`)
    .join('\n\n')
    .substring(0, 20000);

  const errorContextStr = codeErrors.map((r) => {
    // logs can be a string OR an array of {job, log} objects from getCompileStatus
    let logsStr = '';
    if (Array.isArray(r.logs)) {
      logsStr = r.logs.map((l) => `=== ${l.job} ===\n${typeof l.log === 'string' ? l.log : JSON.stringify(l.log)}`).join('\n\n');
    } else if (typeof r.logs === 'string') {
      logsStr = r.logs;
    }
    if (logsStr.length > 8000) logsStr = logsStr.slice(-8000);
    return JSON.stringify({
      component: r.component, error: r.error || r.message, logs: logsStr
    });
  }).join('\n');

  const planSection = plan ? `ARCHITECTURE PLAN:\n${JSON.stringify(plan, null, 2)}\n` : '';
  const componentsSection = components ? `COMPONENTS:\n${JSON.stringify(components, null, 2)}\n` : '';

  const prompt = `You are Morpheus, an elite debugger. The following ${contextType} operation had errors. Analyze each error and regenerate the broken files with fixes.

${planSection}${componentsSection}
ERRORS:
${errorContextStr}

CURRENT PROJECT FILES:
${fileContext}

For each error:
1. Identify the root cause (syntax error, wrong API format, missing export, incorrect config, bad import, etc.)
2. Regenerate the affected files with the fix applied
3. Keep all other files unchanged

Return ONLY the files that need to be updated (the fixed versions). Each file must have its full corrected content — no placeholders, no diffs, no TODOs.

Respond as JSON: { "fixes": [{ "component": "string", "issue": "string", "fix": "string", "files": [{ "path": "string", "content": "string" }] }], "summary": "string" }`;

  // 2026-09-03 audit (see chatWithMorpheus.js's OUTPUT_TRUNCATED postmortem):
  // this call regenerates FULL content for every broken file in one shot and
  // had no maxTokens set — same unbounded-output shape. Errors are usually
  // limited to a handful of files, so this doesn't need full chunking like
  // generateTests/generateBackend, but it does need an explicit cap rather
  // than relying on the provider's undocumented default.
  const { result } = await invokeAI({ userId, prompt, schema: fixResponseSchema, fileUrls: undefined, role: 'diagnosis', maxTokens: 32000 });
  let fixes = result.fixes || [];

  // ── Reviewer: check the regenerated fix files before applying, retry on critical issues ──
  if (fixes.length > 0) {
    const fileOps = [];
    for (const fix of fixes) {
      for (const file of (fix.files || [])) {
        const fullPath = file.path.includes('/') ? file.path : `${fix.component || 'src'}/${file.path}`;
        fileOps.push({ path: fullPath, content: file.content, action: 'create' });
      }
    }
    if (fileOps.length > 0) {
      const reviewed = await reviewAndRetry(userId, fileOps, fileContext, undefined, prompt);
      const correctedByPath = new Map(reviewed.fileOps.map((op) => [op.path, op.content]));
      for (const fix of fixes) {
        for (const file of (fix.files || [])) {
          const fullPath = file.path.includes('/') ? file.path : `${fix.component || 'src'}/${file.path}`;
          if (correctedByPath.has(fullPath)) {
            file.content = correctedByPath.get(fullPath);
          }
        }
      }
    }
  }

  return await applyFileFixes(userId, projectId, projectFiles, fixes);
}
