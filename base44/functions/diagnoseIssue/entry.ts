import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { invokeAI } from '../../shared/aiUtils.ts';
import { logUsage } from '../../shared/projectUtils.ts';
import { getServiceOption } from '../../shared/infrastructureComponents.ts';
import {
  isCredentialError, isAuthError, buildCredentialAction,
  applyFileFixes, fixResponseSchema, type Diagnosis
} from '../../shared/diagnosis.ts';
import { reviewAndRetry } from '../../shared/reviewer.ts';

// Unified Morpheus diagnosis agent. Analyzes errors across the entire platform
// (deploy, compile, github, build), auto-fixes code-level issues by regenerating
// broken files with error context, and returns a structured action plan for
// remaining issues that need user action.

type IssueType = 'deploy' | 'compile' | 'github' | 'build';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { type, projectId, errorContext, components } = body as {
      type: IssueType; projectId: string; errorContext: any; components?: any;
    };
    if (!type || !projectId) return Response.json({ error: 'type and projectId required' }, { status: 400 });

    const project = await base44.entities.Project.get(projectId);
    const files = await base44.entities.ProjectFile.filter({ project_id: projectId });

    let diagnosis: Diagnosis;

    switch (type) {
      case 'deploy':
        diagnosis = await diagnoseDeploy(base44, projectId, project, files, errorContext, components);
        break;
      case 'compile':
        diagnosis = await diagnoseCompile(base44, projectId, project, files, errorContext);
        break;
      case 'github':
        diagnosis = await diagnoseGithub(base44, projectId, project, files, errorContext);
        break;
      case 'build':
        diagnosis = await diagnoseBuild(base44, projectId, project, files, errorContext);
        break;
      default:
        return Response.json({ error: `Unknown issue type: ${type}` }, { status: 400 });
    }

    await logUsage(base44, 'diagnosis', projectId, project.name, {
      phase: `diagnose_${type}`,
      diagnosisType: type,
      summary: diagnosis.summary,
      allClear: diagnosis.allClear,
      autoFixed: diagnosis.autoFixed.map(f => ({ component: f.component, issue: f.issue, fix: f.fix, fileCount: f.fileCount })),
      needsAction: diagnosis.needsUserAction.map(a => ({ component: a.component, label: a.label, issue: a.issue, severity: a.severity }))
    });

    return Response.json({ diagnosis });
  } catch (error) {
    console.error('Diagnose issue error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}

// ─── DEPLOY ──────────────────────────────────────────────────────────────────
async function diagnoseDeploy(base44: any, projectId: string, project: any, files: any[], deployResults: any[], components: any): Promise<Diagnosis> {
  const planFile = files.find(f => f.path === 'backend/.plan.json');
  const plan = planFile ? JSON.parse(planFile.content) : null;
  const backendFiles = files.filter(f => f.path.startsWith('backend/') && f.path !== 'backend/.plan.json' && f.path !== 'backend/.deploy.json');

  const errorResults = (deployResults || []).filter((r: any) => r.status === 'error');
  const manualResults = (deployResults || []).filter((r: any) => r.status === 'zip' || r.status === 'sql-ready');

  const needsUserAction: any[] = [];
  const codeErrors: any[] = [];

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

  const autoFixed = await autoFixCodeErrors(base44, projectId, backendFiles, codeErrors, plan, components, 'backend');

  const allClear = autoFixed.length === codeErrors.length && needsUserAction.length === 0 && errorResults.length === 0;
  return {
    summary: allClear ? 'All errors resolved. Click REDEPLOY to go live.'
      : `${autoFixed.length} issue(s) auto-fixed, ${needsUserAction.length} need your action.`,
    autoFixed, needsUserAction,
    totalErrors: errorResults.length + manualResults.length, allClear
  };
}

// ─── COMPILE ─────────────────────────────────────────────────────────────────
async function diagnoseCompile(base44: any, projectId: string, project: any, files: any[], errorContext: any): Promise<Diagnosis> {
  const { error, logs, repoUrl, target } = errorContext || {};
  const sourceFiles = files.filter(f => !f.path.startsWith('backend/') && !f.path.startsWith('external/'));

  const needsUserAction: any[] = [];
  const codeErrors: any[] = [];

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

  const autoFixed = await autoFixCodeErrors(base44, projectId, sourceFiles, codeErrors, null, null, 'compile', errorContext);

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
async function diagnoseGithub(base44: any, projectId: string, project: any, files: any[], errorContext: any): Promise<Diagnosis> {
  const { error, repoName } = errorContext || {};
  const needsUserAction: any[] = [];
  const codeErrors: any[] = [];

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
  const autoFixed: any[] = [];

  const allClear = autoFixed.length === codeErrors.length && needsUserAction.length === 0 && !error;
  return {
    summary: allClear ? 'All issues resolved. Retry the push.'
      : `${autoFixed.length} issue(s) auto-fixed, ${needsUserAction.length} need your action.`,
    autoFixed, needsUserAction,
    totalErrors: error ? 1 : 0, allClear
  };
}

// ─── BUILD (autonomous) ───────────────────────────────────────────────────────
async function diagnoseBuild(base44: any, projectId: string, project: any, files: any[], errorContext: any): Promise<Diagnosis> {
  const { error, step, spec } = errorContext || {};
  const sourceFiles = files.filter(f => !f.path.startsWith('backend/') && !f.path.startsWith('external/'));

  const needsUserAction: any[] = [];
  const codeErrors: any[] = [];

  if (error) {
    codeErrors.push({ component: 'build', error, step, spec });
  }

  const autoFixed = await autoFixCodeErrors(base44, projectId, sourceFiles, codeErrors, null, null, 'build', errorContext);

  const allClear = autoFixed.length > 0 && needsUserAction.length === 0;
  return {
    summary: allClear ? 'All errors auto-fixed. Restart the autonomous build.'
      : `${autoFixed.length} issue(s) auto-fixed, ${needsUserAction.length} need your action.`,
    autoFixed, needsUserAction,
    totalErrors: codeErrors.length, allClear
  };
}

// ─── SHARED AUTO-FIX ──────────────────────────────────────────────────────────
async function autoFixCodeErrors(
  base44: any, projectId: string, projectFiles: any[], codeErrors: any[],
  plan: any, components: any, contextType: string, errorContext?: any
): Promise<any[]> {
  if (codeErrors.length === 0 || projectFiles.length === 0) return [];

  const fileContext = projectFiles
    .map(f => `--- ${f.path} ---\n${f.content.substring(0, 2000)}`)
    .join('\n\n')
    .substring(0, 20000);

  const errorContextStr = codeErrors.map((r: any) => {
    // logs can be a string OR an array of {job, log} objects from getCompileStatus
    let logsStr = '';
    if (Array.isArray(r.logs)) {
      logsStr = r.logs.map((l: any) => `=== ${l.job} ===\n${typeof l.log === 'string' ? l.log : JSON.stringify(l.log)}`).join('\n\n');
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

  const { result } = await invokeAI(base44, prompt, fixResponseSchema, undefined, 'diagnosis');
  let fixes = result.fixes || [];

  // ── Reviewer: check the regenerated fix files before applying, retry on critical issues ──
  if (fixes.length > 0) {
    const fileOps: any[] = [];
    for (const fix of fixes) {
      for (const file of (fix.files || [])) {
        const fullPath = file.path.includes('/') ? file.path : `${fix.component || 'src'}/${file.path}`;
        fileOps.push({ path: fullPath, content: file.content, action: 'create' });
      }
    }
    if (fileOps.length > 0) {
      const reviewed = await reviewAndRetry(base44, fileOps, fileContext, undefined, prompt);
      const correctedByPath = new Map(reviewed.fileOps.map(op => [op.path, op.content]));
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

  return await applyFileFixes(base44, projectId, projectFiles, fixes);
}