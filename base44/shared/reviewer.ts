// Reviewer agent — the third phase of the build pipeline.
// After the Coder produces fileOperations but BEFORE they are committed,
// the Reviewer checks them for correctness, security, and performance.
// If critical issues are found, the Coder gets ONE retry pass with the
// review feedback. Then the files commit regardless — the review never
// blocks a build permanently, it just cleans it when it can.

import { invokeAI } from './aiUtils.ts';

export interface ReviewIssue {
  path: string;
  severity: 'critical' | 'warning';
  message: string;
}

export interface ReviewResult {
  issues: ReviewIssue[];
  summary: string;
  approved: boolean;
  provider: 'platform' | 'custom';
  model: string;
}

const REVIEWER_PROMPT = `You are Morpheus, the REVIEW agent in the build pipeline.

You receive a set of proposed file operations from the coding agent. Your job is to review them for correctness, security, and performance BEFORE they are committed. Be precise and technical — not stylistic.

Check for:
- CORRECTNESS: syntax errors, malformed code (unbalanced braces, broken JSX), undefined imports (imported names that don't exist), missing await on async calls, wrong function signatures, undefined variables, references to files not being created.
- SECURITY: eval(), new Function(), hardcoded secrets/API keys, SQL injection vectors, innerHTML with unescaped user input, command injection.
- PERFORMANCE: N+1 query patterns, missing memoization on expensive recomputes, redundant re-renders, O(n²) where O(n) is trivial, synchronous blocking I/O in hot paths, oversized bundle inclusions.
- COMPLETENESS: leftover placeholders, TODO, FIXME, "pseudo-code", "..." meant as real content, empty function bodies.
- UI POLISH (warning severity — never block a build on these, just flag them): raw unstyled HTML relying on browser defaults for a web UI, missing hover/focus/transition states on interactive elements, inconsistent or ad-hoc spacing/typography with no scale, missing responsive breakpoints for a web UI, absent empty/loading/error states where a user would hit them, broken or inaccessible color contrast, hardcoded colors that ignore any design tokens the project defines. These are warnings — they surface polish gaps in the summary but must NOT be marked critical.

Do NOT comment on naming or formatting. Only flag issues that would break the code, cause runtime failures, materially degrade performance, or (as warnings) leave the UI visibly unpolished. Be concise — one line per issue.

Return JSON with:
- issues: array of { path, severity ("critical"|"warning"), message }
- summary: one-sentence overall verdict
- approved: true if no critical issues were found, false if any critical issues exist`;

export async function reviewFileOperations(
  base44,
  fileOps: any[],
  contextBlock: string,
  plan?: string
): Promise<ReviewResult> {
  const opsBlock = fileOps.map((op, i) =>
    `--- FILE ${i + 1}: ${op.path} (action: ${op.action || 'create'}) ---\n${op.content || '(empty)'}`
  ).join('\n\n');

  const planNote = plan ? `\n\nORIGINAL BUILD PLAN (for context):\n${plan}` : '';

  const review = await invokeAI(base44,
    `${REVIEWER_PROMPT}\n${contextBlock}\n\nPROPOSED FILE OPERATIONS TO REVIEW:\n${opsBlock}${planNote}\n\nReview these files now.`,
    {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              severity: { type: 'string', enum: ['critical', 'warning'] },
              message: { type: 'string' }
            }
          }
        },
        summary: { type: 'string', description: 'One-sentence overall verdict' },
        approved: { type: 'boolean', description: 'true if no critical issues' }
      }
    },
    undefined,
    'reviewer'
  );

  const result = review.result;
  const issues: ReviewIssue[] = Array.isArray(result.issues) ? result.issues : [];
  const criticalIssues = issues.filter(i => i.severity === 'critical');
  return {
    issues,
    summary: result.summary || 'Review complete.',
    approved: !criticalIssues.some(i => i.severity === 'critical') && !!result.approved,
    provider: review.provider,
    model: review.model,
  };
}

// Format the review outcome for the Morpheus chat. Critical issues are
// emitted on lines prefixed with a marker the chat UI renders in red, so
// the operator can spot what still needs fixing at a glance. Warnings are
// omitted from the chat to keep it readable — only blockers surface.
export function formatReviewChatBlock(review: { summary?: string; approved: boolean; issues: ReviewIssue[] }): string {
  const critical = review.issues.filter(i => i.severity === 'critical');
  const lines: string[] = [];
  if (review.summary) lines.push(`// REVIEW: ${review.summary}`);
  if (critical.length > 0) {
    lines.push(`// CRITICAL ISSUES (${critical.length}):`);
    for (const c of critical) lines.push(`// CRITICAL: ${c.path}: ${c.message}`);
  }
  return lines.join('\n');
}

// Build the feedback prompt for a coder retry after review found issues.
export function buildRetryPrompt(fileOps: any[], review: ReviewResult, plan?: string): string {
  const issuesList = review.issues.map((i, idx) =>
    `${idx + 1}. [${i.severity.toUpperCase()}] ${i.path}: ${i.message}`
  ).join('\n');

  const opsBlock = fileOps.map((op, i) =>
    `--- FILE ${i + 1}: ${op.path} ---\n${op.content || '(empty)'}`
  ).join('\n\n');

  return `The review agent found the following issues in your previous output:\n\n${issuesList}\n\nYour previous file operations were:\n${opsBlock}\n\n${plan ? 'ORIGINAL BUILD PLAN:\n' + plan + '\n\n' : ''}Fix ALL the critical issues above and re-output the complete, corrected fileOperations array. Only re-output files that need changes, but each re-output file must have FULL corrected content. Do not re-output files with no issues.`;
}

// Shared review-and-retry loop. Used by ALL code-producing agents (chat,
// autonomous, backend, tests, diagnosis) to ensure every code output gets
// checked and fixed before commit. Runs the Reviewer on the initial fileOps;
// if critical issues are found, gives the Coder one retry pass with the
// feedback, then returns the merged result. Never blocks — commits regardless.
export async function reviewAndRetry(
  base44,
  fileOps: any[],
  contextBlock: string,
  plan: string | undefined,
  coderPrompt: string
): Promise<{ fileOps: any[]; reviewerModel?: string; reviewSummary?: string; reviewed: boolean; approved: boolean; issues: ReviewIssue[] }> {
  if (fileOps.length === 0) return { fileOps, reviewed: false, approved: true, issues: [] };

  // Always deduplicate by path (last wins) — the LLM sometimes returns both
  // "package.json" and "backend/package.json" which map to the same path.
  const byPath = new Map(fileOps.map(op => [op.path, op]));
  const dedupedOps = Array.from(byPath.values());

  const review = await reviewFileOperations(base44, dedupedOps, contextBlock, plan);

  if (!review.approved && review.issues.some(i => i.severity === 'critical')) {
    const retrySchema = {
      type: 'object',
      properties: {
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
        }
      }
    };
    const retry = await invokeAI(base44, `${coderPrompt}\n\n${buildRetryPrompt(dedupedOps, review, plan)}`, retrySchema, undefined, 'coder');
    const corrected = Array.isArray(retry.result.fileOperations) ? retry.result.fileOperations : [];
    for (const c of corrected) {
      if (c.path) byPath.set(c.path, c);
    }
    const finalOps = Array.from(byPath.values());
    // Re-review after retry so the caller gets an accurate approval status.
    const reReview = await reviewFileOperations(base44, finalOps, contextBlock, plan);
    return {
      fileOps: finalOps,
      reviewerModel: reReview.model,
      reviewSummary: reReview.summary,
      reviewed: true,
      approved: reReview.approved,
      issues: reReview.issues
    };
  }

  return {
    fileOps: dedupedOps,
    reviewerModel: review.model,
    reviewSummary: review.summary,
    reviewed: true,
    approved: review.approved,
    issues: review.issues
  };
}