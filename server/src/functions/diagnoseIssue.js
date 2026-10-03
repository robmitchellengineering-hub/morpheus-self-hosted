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
import { classifyBuildFailure, ownerIsMorpheus } from '../lib/buildFailureOwner.js';
import { getCompileTarget } from '../lib/compile-targets/index.js';
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
    // The ownership verdict, when the classifier reached one, so the rate of
    // Morpheus-owned failures is visible in the usage records rather than only in a
    // log line (see lib/buildFailureOwner.js).
    ...(diagnosis.owner ? { buildFailureOwner: diagnosis.owner } : {}),
    summary: diagnosis.summary,
    allClear: diagnosis.allClear,
    autoFixed: diagnosis.autoFixed.map((f) => ({ component: f.component, issue: f.issue, fix: f.fix, fileCount: f.fileCount })),
    needsAction: diagnosis.needsUserAction.map((a) => ({ component: a.component, label: a.label, issue: a.issue, severity: a.severity })),
  });

  // 2026-09-04 (Rob: "how does the chat know what work was done so they are
  // working together to solve compile issues?" -> "yes" to making it
  // automatic): before this, the ONLY way the chat conversation got any
  // record that a diagnosis/auto-fix ran was if the user manually clicked
  // "ASK MORPHEUS IN CHAT" on the DiagnosisPanel (see Workspace.jsx's
  // onAskMorpheus, which builds a similar summary and sends it as a live
  // chat turn). Go straight from a failed compile/deploy/build to retrying
  // without clicking that button, and the chat had zero memory anything
  // happened — even though chatWithMorpheus.js was silently reading the
  // already-changed file content underneath it on the very next turn.
  // This persists a passive log message every time ANY diagnosis completes
  // (compile/deploy/github/build all funnel through this one handler), so
  // the chat's own conversation history — which chatWithMorpheus.js's
  // `historyContext` feeds back into the AI as real prompt context on every
  // subsequent turn (see that file's `history` query, bounded to the last
  // 20 messages) — always has a durable record of what the fixer found and
  // did, whether or not the user ever opens chat about it.
  //
  // Uses the existing "// SYSTEM" content-prefix convention already
  // established elsewhere (ChatPanel.jsx suppresses the voice-play button
  // for any role:'morpheus' message starting with "// SYSTEM"; useWorkspace.js
  // uses the same prefix for its own client-side "// SYSTEM FAILURE:" error
  // messages) rather than inventing a new `role` value — this way it renders
  // and behaves exactly like every other system-originated note already in
  // this codebase, no frontend changes needed. This is a log entry, not a
  // live turn: it does NOT trigger another AI reply, unlike clicking the
  // "ASK MORPHEUS IN CHAT" button (which still exists for when the operator
  // wants Morpheus to actively act on what's left, not just record it).
  await prisma.chatMessage.create({
    data: {
      created_by_id: user.id,
      project_id: projectId,
      role: 'morpheus',
      content: buildDiagnosisLogMessage(type, diagnosis),
    },
  });

  return { diagnosis };
}

function buildDiagnosisLogMessage(type, diagnosis) {
  const lines = [`// SYSTEM — AI DIAGNOSIS (${type}): ${diagnosis.summary}`];
  if (diagnosis.autoFixed?.length) {
    lines.push('', 'Auto-fixed:');
    for (const f of diagnosis.autoFixed) {
      lines.push(`- ${f.component}: ${f.fix} (${f.fileCount} file(s) regenerated)`);
    }
  }
  if (diagnosis.needsUserAction?.length) {
    lines.push('', 'Still needs your action:');
    for (const a of diagnosis.needsUserAction) {
      lines.push(`- ${a.component}: ${a.issue}`);
    }
  }
  return lines.join('\n');
}

// The action plan for a failure the classifier proved belongs to Morpheus. The message
// is the classifier's plain sentence — deliberately no raw log text, no stack trace, and
// no "fix your app" instruction, because no app file can fix a generated workflow.
function buildMorpheusAction(ownership) {
  return {
    component: 'morpheus',
    label: 'Morpheus build pipeline',
    issue: ownership.detail,
    steps: ownership.steps,
    severity: 'morpheus',
  };
}

// The artifact glob the compile target declares, so the release step failing on it is
// recognised as Morpheus's own contract rather than an unknown failure. Best-effort: a
// target id that is missing or not in the registry simply yields no glob, and the
// classifier then falls through to 'unknown' (today's behaviour) instead of guessing.
function artifactGlobFor(target) {
  if (!target) return undefined;
  try {
    return getCompileTarget(target)?.artifact?.glob;
  } catch {
    return undefined;
  }
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

  // PRECEDENCE, and it is an order the code executes rather than a comment: the caller's
  // OWN credential class is decided FIRST, before the ownership verdict is even asked.
  // A credential failure is answered by the branch it always was, and the ownership check
  // cannot pre-empt it. (lib/buildFailureOwner.js carries no credential vocabulary — this
  // is ordering, not classification; it decides only morpheus | app | unknown.)
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

  // 2026-10-01 (measured): classify OWNERSHIP before any AI call, but only when the
  // caller's own branch above did not already answer the failure. A real app's compile
  // failed on both macOS jobs inside Morpheus's OWN generated workflow — the Release step
  // published USER-MANUAL.txt, which the renderer writes before actions/checkout@v4 and
  // the checkout then deletes — and the loop spent a 32,000-token diagnosis (40,365 in,
  // OUTPUT_TRUNCATED, recorded `status: ok`) trying to fix something no app file could
  // fix, on a workflow Morpheus regenerates every compile.
  //
  // Only a confident, evidence-backed 'morpheus' verdict returns here. 'app' and
  // 'unknown' fall through to the code below EXACTLY as it was, because the build
  // pipeline must stay as free as possible — a miss is acceptable, a false "this is
  // Morpheus's fault" that stops a real fix is not (lib/buildFailureOwner.js).
  if (!isAuthError(error)) {
    const ownership = classifyBuildFailure({ error, logs, target, artifactGlob: artifactGlobFor(target) });
    if (ownerIsMorpheus(ownership)) {
      console.warn(`[diagnoseIssue] morpheus-owned compile failure: reason=${ownership.reason} step=${ownership.evidence?.step || '-'} file=${ownership.evidence?.file || '-'} target=${target || '-'} — no AI call made`);
      return {
        summary: ownership.headline,
        autoFixed: [],
        needsUserAction: [buildMorpheusAction(ownership)],
        totalErrors: 1,
        allClear: false,
        owner: ownership.owner,
      };
    }
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

  // The autonomous build shares the auto-fix path with the compile diagnosis, so it gets
  // the same ownership check. This errorContext carries no GitHub job logs, so a
  // Morpheus-owned workflow failure is rarely visible here — but the check is cheap, and
  // like the compile path it changes nothing unless a confident 'morpheus' verdict lands.
  const ownership = classifyBuildFailure({ error });
  if (ownerIsMorpheus(ownership)) {
    console.warn(`[diagnoseIssue] morpheus-owned build failure: reason=${ownership.reason} step=${ownership.evidence?.step || '-'} file=${ownership.evidence?.file || '-'} — no AI call made`);
    return {
      summary: ownership.headline,
      autoFixed: [],
      needsUserAction: [buildMorpheusAction(ownership)],
      totalErrors: 1,
      allClear: false,
      owner: ownership.owner,
    };
  }

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

  // 2026-09-04 fix (Rob: AnyPDF's Swift compile kept failing again after
  // being "auto-fixed", and the fix messages read as generic re-completions
  // rather than targeted patches): this used to cap each file at 2000 chars
  // and the whole joined context at 20000 chars before handing it to the
  // "regenerate the affected files with the fix applied" prompt below. Real
  // source files here (PDFViewContainer.swift, ContentView.swift, etc.) run
  // 2500-4000 chars each -- so the fixer AI was working from a file cut off
  // partway through, with no way to know what it couldn't see. Told to
  // "regenerate the full corrected content" from a truncated view, it did
  // exactly that: reconstructed a plausible-looking whole file from the
  // fragment + error text instead of patching the actual current bug,
  // which is why the diagnosis kept reporting fixes that didn't stick.
  // chatWithMorpheus.js's ordinary (non-self-dev) project path already
  // sends full, untruncated file content the same way (see its filesContext
  // above) at these same project sizes without issue, so this brings
  // diagnosis in line with that rather than inventing a new convention.
  // The 150000 ceiling is a backstop against a pathologically large project,
  // not a normal-case limit.
  const fileContext = projectFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n')
    .substring(0, 150000);

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
