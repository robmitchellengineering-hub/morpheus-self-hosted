// Ported from base44/functions/autonomousBuildStep/entry.ts.
//
// The self-driving build loop: one call = one step. Same pipeline shape as
// chatWithMorpheus (Planner → Coder → Reviewer) but loop-driven with
// per-step file budgeting (the planner is instructed to plan only 3-5 files
// per step to avoid truncating the coder's output window) and NO
// clarification gate — autonomous mode always proceeds, making its own
// reasonable choices instead of asking the operator.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { createSnapshot, applyFileOperations, logUsage } from '../lib/projectUtils.js';
import { buildToolchain } from '../lib/toolchain.js';
import { reviewAndRetry, formatReviewChatBlock } from '../lib/reviewer.js';
import { getContextSummary, formatContextSummaryBlock } from '../lib/contextSummary.js';

// ─── OUTPUT MEASUREMENT ──────────────────────────────────────────────────────
// Tracks actual output sizes per agent phase so we can see how much of the
// token window each uses and tune batch sizes for maximum throughput.
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function measureFileOps(ops) {
  const perFile = ops.map((op) => {
    const chars = (op.content || '').length;
    return { path: op.path, chars, tokens: Math.ceil(chars / 4) };
  });
  const totalChars = perFile.reduce((s, f) => s + f.chars, 0);
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
- assessment: brief analysis of current state and what is missing
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

export default async function handler({ user, body }) {
  const { projectId, spec } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  // 2026-09-02 fix: ProjectFile's real uniqueness is [project_id, path]
  // (schema.prisma), not per-user. Filtering by created_by_id: user.id here
  // hid files with a different created_by_id from applyFileOperations()'s
  // existence check below, causing a blind create() -> Prisma P2002 crash
  // on an already-existing path. Project ownership is already enforced via
  // the `project` lookup above, so scoping by project_id alone is safe.
  const files = await prisma.projectFile.findMany({ where: { project_id: projectId } });
  // Bounded to the last 10 messages, matching the original
  // (base44/functions/autonomousBuildStep/entry.ts fetches `('created_date', 10)`).
  // See chatWithMorpheus.js for why "load everything" was reverted — same
  // unbounded-prompt-growth issue, worse here since this loop calls the AI
  // repeatedly per autonomous run.
  const history = await prisma.chatMessage.findMany({
    where: { project_id: projectId, created_by_id: user.id },
    orderBy: { created_date: 'desc' },
    take: 10,
  });
  history.reverse();

  // Compressed memory of older messages beyond the 10-message window above
  // — see lib/contextSummary.js (shared with chatWithMorpheus.js).
  const contextSummary = await getContextSummary(user.id, project, 'autonomous');
  const summaryBlock = formatContextSummaryBlock(contextSummary);

  await createSnapshot(user.id, projectId, 'Autonomous build step');

  const filesContext = files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n') || '(no files yet)';
  const historyContext = history.map((h) => `${h.role === 'user' ? 'Operator' : 'Morpheus'}: ${h.content}`).join('\n') || '(conversation just started)';

  const contextBlock = `
PROJECT: ${project.name}
${project.description ? 'DESCRIPTION: ' + project.description : ''}
COMPILE TARGET: ${project.compile_target || 'source'}
${spec ? 'OPERATOR SPEC: ' + spec : ''}
${summaryBlock}

CURRENT FILES:
${filesContext}

RECENT CONVERSATION:
${historyContext}`;

  // ── Phase 1: Planner reasons about what to build ──────────────────────────
  const planner = await invokeAI({
    userId: user.id,
    prompt: `${PLANNER_PROMPT}\n${contextBlock}\n\nAnalyze the current state. Determine what's missing for a complete, production-ready, deployable project. Produce a precise build plan. If already complete, set isComplete: true.`,
    schema: {
      type: 'object',
      properties: {
        assessment: { type: 'string', description: 'Brief analysis of current state and what is missing' },
        plan: { type: 'string', description: 'Detailed file-by-file build plan with implementation notes' },
        isComplete: { type: 'boolean', description: 'true only if the project is already fully production-ready' }
      }
    },
    fileUrls: undefined,
    role: 'planner',
  });

  const plannerResult = planner.result;
  const plannerMetrics = {
    chars: JSON.stringify(plannerResult).length,
    estTokens: estimateTokens(JSON.stringify(plannerResult)),
    usage: planner.usage,
  };

  // If planner says the project is already done, skip the coder
  if (plannerResult.isComplete) {
    const reply = `[PLAN] ${plannerResult.assessment || 'Construct is already production-ready.'}`;
    await prisma.chatMessage.create({ data: { created_by_id: user.id, project_id: projectId, role: 'morpheus', content: `[AUTONOMOUS] ${reply}` } });
    await prisma.project.update({ where: { id: projectId }, data: { status: 'ready' } });
    const toolchain = buildToolchain(planner.provider, { planner: planner.model });
    const outputMetrics = { planner: plannerMetrics, coder: { totalChars: 0, totalTokens: 0, perFile: [] }, totalEstTokens: plannerMetrics.estTokens };
    await logUsage(user.id, 'autonomous_step', projectId, project.name, { isComplete: true, phase: 'planner-only', fileCount: 0, outputMetrics, ...toolchain });
    return { reply, fileOperations: [], isComplete: true, plannerAssessment: plannerResult.assessment, outputMetrics };
  }

  // ── Phase 2: Coder implements the plan ────────────────────────────────────
  let coderResult;
  let coderInfo;
  let truncated = false;
  try {
    const coder = await invokeAI({
      userId: user.id,
      prompt: `${CODER_PROMPT}\n${contextBlock}\n\nPLANNER ASSESSMENT:\n${plannerResult.assessment || '(none)'}\n\nBUILD PLAN:\n${plannerResult.plan || '(no plan provided)'}\n\nImplement this plan now. Write the actual code files. Output ONLY 4-5 files maximum — the most critical ones from the plan. Each file must be COMPLETE.`,
      schema: {
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
      },
      fileUrls: undefined,
      role: 'coder',
    });
    coderResult = coder.result;
    coderInfo = { provider: coder.provider, model: coder.model, usage: coder.usage };
  } catch (e) {
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
  let reviewerModel;
  let reviewSummary;
  let reviewApproved = true;
  let reviewIssues = [];
  if (fileOps.length > 0) {
    const coderPrompt = `${CODER_PROMPT}\n${contextBlock}\n\nPLANNER ASSESSMENT:\n${plannerResult.assessment || '(none)'}\n\nBUILD PLAN:\n${plannerResult.plan || '(no plan provided)'}\n\nImplement this plan now. Write the actual code files.`;
    const reviewed = await reviewAndRetry(user.id, fileOps, contextBlock, plannerResult.plan, coderPrompt);
    fileOps = reviewed.fileOps;
    reviewerModel = reviewed.reviewerModel;
    reviewSummary = reviewed.reviewSummary;
    reviewApproved = reviewed.approved;
    reviewIssues = reviewed.issues || [];
  }

  const appliedOps = await applyFileOperations(user.id, projectId, fileOps, files);

  // The coder may claim complete, but if the reviewer found critical issues
  // the project is NOT ready — the panel must keep going until review passes.
  const finalComplete = isComplete && reviewApproved;

  const reviewBlock = (reviewSummary || reviewIssues.some((i) => i.severity === 'critical'))
    ? formatReviewChatBlock({ summary: reviewSummary, approved: reviewApproved, issues: reviewIssues })
    : '';
  const reviewLine = reviewBlock ? `\n${reviewBlock}` : '';
  const reply = `[PLAN] ${plannerResult.assessment || '...'}\n[CODE] ${coderReply}${reviewLine}`;
  await prisma.chatMessage.create({ data: { created_by_id: user.id, project_id: projectId, role: 'morpheus', content: `[AUTONOMOUS] ${reply}` } });

  if (finalComplete) {
    await prisma.project.update({ where: { id: projectId }, data: { status: 'ready' } });
  } else if (fileOps.length > 0) {
    await prisma.project.update({ where: { id: projectId }, data: { status: 'building' } });
  }

  const toolchain = buildToolchain(planner.provider, { planner: planner.model, coder: coderInfo?.model, reviewer: reviewerModel });
  const outputMetrics = {
    planner: plannerMetrics,
    coder: coderMetrics,
    totalEstTokens: plannerMetrics.estTokens + coderMetrics.totalTokens,
  };
  await logUsage(user.id, 'autonomous_step', projectId, project.name, { isComplete: finalComplete, fileCount: fileOps.length, reviewed: !!reviewerModel, reviewApproved, truncated, outputMetrics, ...toolchain });
  return { reply, fileOperations: appliedOps, isComplete: finalComplete, truncated, plannerAssessment: plannerResult.assessment, reviewStatus: { approved: reviewApproved, issues: reviewIssues, summary: reviewSummary }, outputMetrics };
}
