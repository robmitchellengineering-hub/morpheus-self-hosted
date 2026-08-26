// Reviewer agent — the third phase of the build pipeline.
// After the Coder produces fileOperations but BEFORE they are committed,
// the Reviewer checks them for correctness, security, and performance.
// If critical issues are found, the Coder gets ONE retry pass with the
// review feedback. Then the files commit regardless — the review never
// blocks a build permanently, it just cleans it when it can.

import { chat } from './llm.js';

const REVIEWER_PROMPT = `You are Morpheus, the REVIEW agent in the build pipeline.

You receive a set of proposed file operations from the coding agent. Your job is to review them for correctness, security, and performance BEFORE they are committed. Be precise and technical — not stylistic.

Check for:
- CORRECTNESS: syntax errors, malformed code (unbalanced braces, broken JSX), undefined imports (imported names that don't exist), missing await on async calls, wrong function signatures, undefined variables, references to files not being created.
- SECURITY: eval(), new Function(), hardcoded secrets/API keys, SQL injection vectors, innerHTML with unescaped user input, command injection.
- PERFORMANCE: N+1 query patterns, missing memoization on expensive recomputes, redundant re-renders, O(n²) where O(n) is trivial, synchronous blocking I/O in hot paths, oversized bundle inclusions.
- COMPLETENESS: leftover placeholders, TODO, FIXME, "pseudo-code", "..." meant as real content, empty function bodies.

Do NOT comment on naming, formatting, or aesthetic preferences. Only flag issues that would break the code, cause runtime failures, or materially degrade performance. Be concise — one line per issue.

Return JSON with:
- issues: array of { path, severity ("critical"|"warning"), message }
- summary: one-sentence overall verdict
- approved: true if no critical issues were found, false if any critical issues exist`;

const CODER_RETRY_SCHEMA = {
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

const REVIEW_SCHEMA = {
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
    summary: { type: 'string' },
    approved: { type: 'boolean' }
  }
};

async function reviewFileOperations(fileOps, contextBlock, plan) {
  const opsBlock = fileOps.map((op, i) =>
    `--- FILE ${i + 1}: ${op.path} (action: ${op.action || 'create'}) ---\n${op.content || '(empty)'}`
  ).join('\n\n');
  const planNote = plan ? `\n\nORIGINAL BUILD PLAN (for context):\n${plan}` : '';

  const { content } = await chat(
    [
      { role: 'system', content: REVIEWER_PROMPT },
      { role: 'user', content: `${contextBlock}\n\nPROPOSED FILE OPERATIONS TO REVIEW:\n${opsBlock}${planNote}\n\nReview these files now.` }
    ],
    { schema: REVIEW_SCHEMA, role: 'reviewer' }
  );

  const issues = Array.isArray(content.issues) ? content.issues : [];
  const critical = issues.some((i) => i.severity === 'critical');
  return {
    issues,
    summary: content.summary || 'Review complete.',
    approved: !critical && !!content.approved,
  };
}

function buildRetryPrompt(fileOps, review, plan) {
  const issuesList = review.issues.map((i, idx) =>
    `${idx + 1}. [${i.severity.toUpperCase()}] ${i.path}: ${i.message}`
  ).join('\n');
  const opsBlock = fileOps.map((op, i) =>
    `--- FILE ${i + 1}: ${op.path} ---\n${op.content || '(empty)'}`
  ).join('\n\n');
  return `The review agent found the following issues in your previous output:\n\n${issuesList}\n\nYour previous file operations were:\n${opsBlock}\n\n${plan ? 'ORIGINAL BUILD PLAN:\n' + plan + '\n\n' : ''}Fix ALL the critical issues above and re-output the complete, corrected fileOperations array. Only re-output files that need changes, but each re-output file must have FULL corrected content. Do not re-output files with no issues.`;
}

// Shared review-and-retry loop. Runs the Reviewer on the initial fileOps;
// if critical issues are found, gives the Coder one retry pass with the
// feedback, then returns the merged result. Never blocks — commits regardless.
export async function reviewAndRetry(fileOps, contextBlock, plan, coderSystem, coderUser) {
  if (!fileOps || fileOps.length === 0) return { fileOps, reviewSummary: null, reviewed: false };

  // Deduplicate by path (last wins).
  const byPath = new Map(fileOps.map((op) => [op.path, op]));
  const deduped = Array.from(byPath.values());

  const review = await reviewFileOperations(deduped, contextBlock, plan);

  if (!review.approved && review.issues.some((i) => i.severity === 'critical')) {
    const { content } = await chat(
      [
        { role: 'system', content: coderSystem },
        { role: 'user', content: `${coderUser}\n\n${buildRetryPrompt(deduped, review, plan)}` }
      ],
      { schema: CODER_RETRY_SCHEMA, role: 'coder' }
    );
    const corrected = Array.isArray(content.fileOperations) ? content.fileOperations : [];
    for (const c of corrected) if (c.path) byPath.set(c.path, c);
    const finalOps = Array.from(byPath.values());
    const reReview = await reviewFileOperations(finalOps, contextBlock, plan);
    return { fileOps: finalOps, reviewSummary: reReview.summary, reviewed: true };
  }

  return { fileOps: deduped, reviewSummary: review.summary, reviewed: true };
}