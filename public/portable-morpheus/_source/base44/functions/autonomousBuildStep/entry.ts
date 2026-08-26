import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { createSnapshot, applyFileOperations, logUsage } from '../../shared/projectUtils.ts';
import { invokeAI } from '../../shared/aiUtils.ts';
import { buildToolchain } from '../../shared/toolchain.ts';
import { reviewAndRetry } from '../../shared/reviewer.ts';

// ─── OUTPUT MEASUREMENT ──────────────────────────────────────────────────────
// Tracks actual output sizes per agent phase so we can see how much of the
// token window each uses and tune batch sizes for maximum throughput.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function measureFileOps(ops: any[]) {
  const perFile = ops.map(op => {
    const chars = (op.content || '').length;
    return { path: op.path, chars, tokens: Math.ceil(chars / 4) };
  });
  const totalChars = perFile.reduce((s: number, f: any) => s + f.chars, 0);
  return { totalChars, totalTokens: Math.ceil(totalChars / 4), perFile };
}

// ─── PLANNER ─────────────────────────────────────────────────────────────────
// High think-power agent. Analyzes the project, reasons about architecture,
// design, aesthetics, and produces a precise build plan the coder can follow.
const PLANNER_PROMPT = `You are Morpheus, the PLANNING agent in AUTONOMOUS MODE.

Your role is pure reasoning: analyze the construct, decide what's needed for a complete, production-ready, deployable project, and produce a precise build plan. You do NOT write code — you design the architecture and describe exactly what each file should contain.

Think deeply about:
- Architecture and file structure — what files are needed and why
- User experience, aesthetics, and usability
- Reliability, error handling, and edge cases
- Dependencies and build configuration for the compile target
- What's missing vs what already exists

A complete project MUST have:
- All source files with real, working logic (no placeholders, no TODOs)
- package.json (or equivalent) with proper dependencies and scripts
- README.md with setup, run, and build instructions
- Build configuration matching the compile target (if not 'source')
- Any necessary config files (.env.example, tsconfig, Dockerfile, etc.)
- Tests if appropriate for the project type

If the project is ALREADY complete and production-ready, set isComplete: true and leave the plan empty.

Your plan must be specific enough that a coder agent can implement it without ambiguity — list every file to create/update, and describe what each should contain, its purpose, and key implementation details.

OUTPUT BUDGETING — CRITICAL:
The coder agent has a LIMITED output window per step (~16K tokens). If it tries to write too many files at once, output gets TRUNCATED and files arrive incomplete or broken. To avoid this:
- PRIORITIZE: build the most critical files first (entry point, core logic, config, package.json)
- BUDGET: plan at most 4-5 files per step, fewer if they are large (over 200 lines)
- If the previous step was truncated, plan ONLY 2 files this step — the smallest, most critical files
- The autonomous loop continues automatically — you do NOT need to build everything in one step
- In your plan, clearly separate "THIS STEP" (files to write now) from "NEXT STEPS" (files deferred to future steps)
- Set isComplete: false until ALL files across all steps are written
- Never let a single file exceed ~1000 lines — split into modules if needed
- Each file must be COMPLETE and self-contained — never partial, never "continued in next step"

Return JSON with:
- assessment: brief analysis of current state and what's missing
- plan: detailed build plan — start with "THIS STEP:" listing the 3-5 files to write now with implementation notes, then "NEXT STEPS:" listing deferred files
- isComplete: true only if the project is already fully production-ready`;

// ─── CODER ───────────────────────────────────────────────────────────────────
// Fast lightweight agent. Takes the planner's blueprint and writes clean,
// efficient, deployable code. No design decisions — just implementation.
const CODER_PROMPT = `You are Morpheus, the CODING agent in AUTONOMOUS MODE.

You receive a build plan from the planning agent and implement it precisely. Write clean, efficient, production-ready code — no placeholders, no TODOs, no pseudo-code. Follow the plan exactly.

Rules:
- Every file must have FULL content (never partial)
- Code must be deployable — proper imports, error handling, real logic
- Match the compile target's conventions and config requirements
- If the plan says the project is complete after these files, set isComplete: true

Return JSON with:
- reply: one-sentence summary of what was built
- fileOperations: array of { path, content, action } where action is "create", "update", or "delete"
- isComplete: true if the project is now fully production-ready after these operations`;

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId, spec } = body;
    if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });

    const project = await base44.entities.Project.get(projectId);
    const files = await base44.entities.ProjectFile.filter({ project_id: projectId });
    const history = await base44.entities.ChatMessage.filter({ project_id: projectId }, 'created_date', 10);

    await createSnapshot(base44, projectId, 'Autonomous build step');

    const filesContext = files.map((f: any) => `--- ${f.path} ---\n${f.content}`).join('\n\n') || '(no files yet)';
    const historyContext = history.map((h: any) => `${h.role === 'user' ? 'Operator' : 'Morpheus'}: ${h.content}`).join('\n') || '(conversation just started)';

    const contextBlock = `
PROJECT: ${project.name}
${project.description ? 'DESCRIPTION: ' + project.description : ''}
COMPILE TARGET: ${project.compile_target || 'source'}
${spec ? 'OPERATOR SPEC: ' + spec : ''}

CURRENT FILES:
${filesContext}

RECENT CONVERSATION:
${historyContext}`;

    // ── Phase 1: Planner reasons about what to build ──────────────────────────
    const planner = await invokeAI(base44, `${PLANNER_PROMPT}\n${contextBlock}\n\nAnalyze the current state. Determine what's missing for a complete, production-ready, deployable project. Produce a precise build plan. If already complete, set isComplete: true.`, {
      type: 'object',
      properties: {
        assessment: { type: 'string', description: 'Brief analysis of current state and what is missing' },
        plan: { type: 'string', description: 'Detailed file-by-file build plan with implementation notes' },
        isComplete: { type: 'boolean', description: 'true only if the project is already fully production-ready' }
      }
    }, undefined, 'planner');

    const plannerResult = planner.result;
    const plannerMetrics = {
      chars: JSON.stringify(plannerResult).length,
      estTokens: estimateTokens(JSON.stringify(plannerResult)),
      usage: planner.usage
    };

    // If planner says the project is already done, skip the coder
    if (plannerResult.isComplete) {
      const reply = `[PLAN] ${plannerResult.assessment || 'Construct is already production-ready.'}`;
      await base44.entities.ChatMessage.create({ project_id: projectId, role: 'morpheus', content: `[AUTONOMOUS] ${reply}` });
      await base44.entities.Project.update(projectId, { status: 'ready' });
      const toolchain = buildToolchain(planner.provider, { planner: planner.model });
      const outputMetrics = { planner: plannerMetrics, coder: { totalChars: 0, totalTokens: 0, perFile: [] }, totalEstTokens: plannerMetrics.estTokens };
      await logUsage(base44, 'autonomous_step', projectId, project.name, { isComplete: true, phase: 'planner-only', fileCount: 0, outputMetrics, ...toolchain });
      return Response.json({ reply, fileOperations: [], isComplete: true, plannerAssessment: plannerResult.assessment, outputMetrics });
    }

    // ── Phase 2: Coder implements the plan ────────────────────────────────────
    let coderResult: any;
    let coderInfo: { provider: 'platform' | 'custom'; model: string; usage?: any } | undefined;
    let truncated = false;
    try {
      const coder = await invokeAI(base44, `${CODER_PROMPT}\n${contextBlock}\n\nPLANNER ASSESSMENT:\n${plannerResult.assessment || '(none)'}\n\nBUILD PLAN:\n${plannerResult.plan || '(no plan provided)'}\n\nImplement this plan now. Write the actual code files. Output ONLY 4-5 files maximum — the most critical ones from the plan. Each file must be COMPLETE.`, {
        type: 'object',
        properties: {
          reply: { type: 'string', description: 'Brief summary of what was built' },
          fileOperations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                action: { type: 'string', enum: ['create', 'update', 'delete'] }
              }
            }
          },
          isComplete: { type: 'boolean', description: 'true if the project is now fully production-ready after these operations' }
        }
      }, undefined, 'coder');
      coderResult = coder.result;
      coderInfo = { provider: coder.provider, model: coder.model, usage: coder.usage };
    } catch (e: any) {
      // Output was truncated by token limit — don't crash, signal the panel
      // to continue with a smaller batch. No files are committed this step.
      if (e.message?.includes('OUTPUT_TRUNCATED')) {
        truncated = true;
        coderResult = { reply: 'Output was truncated — reducing batch size for next step.', fileOperations: [], isComplete: false };
      } else {
        throw e;
      }
    }
    const coderReply = coderResult.reply || '...';
    let fileOps = Array.isArray(coderResult.fileOperations) ? coderResult.fileOperations : [];
    const isComplete = !!coderResult.isComplete;
    const coderMetrics = { ...measureFileOps(fileOps), usage: coderInfo?.usage };

    // ── Phase 3: Reviewer checks the output before commit ──────────────────
    let reviewerModel: string | undefined;
    let reviewSummary: string | undefined;
    let reviewApproved = true;
    let reviewIssues: any[] = [];
    if (fileOps.length > 0) {
      const coderPrompt = `${CODER_PROMPT}\n${contextBlock}\n\nPLANNER ASSESSMENT:\n${plannerResult.assessment || '(none)'}\n\nBUILD PLAN:\n${plannerResult.plan || '(no plan provided)'}\n\nImplement this plan now. Write the actual code files.`;
      const reviewed = await reviewAndRetry(base44, fileOps, contextBlock, plannerResult.plan, coderPrompt);
      fileOps = reviewed.fileOps;
      reviewerModel = reviewed.reviewerModel;
      reviewSummary = reviewed.reviewSummary;
      reviewApproved = reviewed.approved;
      reviewIssues = reviewed.issues || [];
    }

    const appliedOps = await applyFileOperations(base44, projectId, fileOps, files);

    // The coder may claim complete, but if the reviewer found critical issues
    // the project is NOT ready — the panel must keep going until review passes.
    const finalComplete = isComplete && reviewApproved;

    const reviewLine = reviewSummary ? `\n[REVIEW] ${reviewSummary}` : '';
    const reply = `[PLAN] ${plannerResult.assessment || '...'}\n[CODE] ${coderReply}${reviewLine}`;
    await base44.entities.ChatMessage.create({ project_id: projectId, role: 'morpheus', content: `[AUTONOMOUS] ${reply}` });

    if (finalComplete) {
      await base44.entities.Project.update(projectId, { status: 'ready' });
    } else if (fileOps.length > 0) {
      await base44.entities.Project.update(projectId, { status: 'building' });
    }

    const toolchain = buildToolchain(planner.provider, { planner: planner.model, coder: coderInfo?.model, reviewer: reviewerModel });
    const outputMetrics = {
      planner: plannerMetrics,
      coder: coderMetrics,
      totalEstTokens: plannerMetrics.estTokens + coderMetrics.totalTokens
    };
    await logUsage(base44, 'autonomous_step', projectId, project.name, { isComplete: finalComplete, fileCount: fileOps.length, reviewed: !!reviewerModel, reviewApproved, truncated, outputMetrics, ...toolchain });
    return Response.json({ reply, fileOperations: appliedOps, isComplete: finalComplete, truncated, plannerAssessment: plannerResult.assessment, reviewStatus: { approved: reviewApproved, issues: reviewIssues, summary: reviewSummary }, outputMetrics });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}