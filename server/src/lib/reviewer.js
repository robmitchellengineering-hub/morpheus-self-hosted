// Reviewer agent — the third phase of the build pipeline.
// After the Coder produces fileOperations but BEFORE they are committed,
// the Reviewer checks them for correctness, security, and performance.
// If critical issues are found, the Coder gets up to MAX_REVIEW_ATTEMPTS - 1
// retry passes with the review feedback, re-reviewing after each. Then the
// files commit regardless — the review never blocks a build permanently, it
// just cleans it when it can.
//
// Rob, 2026-09-15 (Wikidata Batch Uploader build): a single retry pass was
// routinely not enough — real chat history for that build shows him typing
// "fix critical issues and continue" five separate times across the build,
// including twice in a row for what was still the same unresolved issue,
// because a critical finding that survived the one automatic retry just got
// printed in the reply text and nothing tried again until he noticed and
// asked. Bounded to a real loop now, matching the MAX_GATE_ATTEMPTS
// convention chatWithMorpheus.js already uses for its syntax/deep-verify
// gates (server/src/functions/chatWithMorpheus.js ~line 1117) — same "never
// blocks" philosophy, just more real attempts before giving up.

import { invokeAI } from '../ai.js';
import { mapWithConcurrency, maxConcurrentCalls } from './callPool.js';
import {
  REVIEW_BUDGET, createReviewBudget, canSpendReviewCall, planReviewCalls,
  canStartReReviewPass, startReReviewPass, reReviewScope, reviewOutcome,
} from './reviewBudget.js';

const MAX_REVIEW_ATTEMPTS = 3; // real fix-and-recheck attempts, not just one retry
// 2026-09-30: the attempts above are the LOGICAL limit; REVIEW_BUDGET is the SPEND limit and the one that
// actually bounds a run. Measured: a 10-file backend generation made twelve reviewer calls and burned 473
// credits with nothing persisted. See lib/reviewBudget.js.

const REVIEWER_PROMPT = `You are Morpheus, the REVIEW agent in the build pipeline.

You receive a set of proposed file operations from the coding agent. Your job is to review them for correctness, security, and performance BEFORE they are committed. Be precise and technical — not stylistic.

Check for:
- CORRECTNESS: syntax errors, malformed code (unbalanced braces, broken JSX), undefined imports (imported names that don't exist), missing await on async calls, wrong function signatures, undefined variables, references to files not being created.
- SECURITY: eval(), new Function(), hardcoded secrets/API keys, SQL injection vectors, innerHTML with unescaped user input, command injection.
- PERFORMANCE: N+1 query patterns, missing memoization on expensive recomputes, redundant re-renders, O(n²) where O(n) is trivial, synchronous blocking I/O in hot paths, oversized bundle inclusions.
- COMPLETENESS: leftover placeholders, TODO, FIXME, "pseudo-code", "..." meant as real content, empty function bodies.
- UI POLISH (warning severity — never block a build on these, just flag them): raw unstyled HTML relying on browser defaults for a web UI, missing hover/focus/transition states on interactive elements, inconsistent or ad-hoc spacing/typography with no scale, missing responsive breakpoints for a web UI, absent empty/loading/error states where a user would hit them, broken or inaccessible color contrast, hardcoded colors that ignore any design tokens the project defines. These are warnings — they surface polish gaps in the summary but must NOT be marked critical.

- REGRESSIONS AGAINST KNOWN HAZARDS: if the context includes a KNOWN-HAZARDS.md (or similar "things that have already broken this codebase" file), check every proposed change against every item in it. A change that repeats a listed hazard is a CRITICAL issue — cite the hazard by its heading.
- CALLER IMPACT: if the context includes a "CALLER IMPACT" section, it lists files that import a file being changed and the names they pull from it. Verify the change keeps every one of those imports valid — a removed or renamed export, or a signature/return-shape change a listed caller relies on, is a CRITICAL issue. Name the caller.

Do NOT comment on naming or formatting. Only flag issues that would break the code, cause runtime failures, materially degrade performance, or (as warnings) leave the UI visibly unpolished. Be concise — one line per issue.

Return JSON with:
- issues: array of { path, severity ("critical"|"warning"), message }
- summary: one-sentence overall verdict
- approved: true if no critical issues were found, false if any critical issues exist`;

// The reviewer prompt for one batch, in one place. Exported so the reviewer can
// be exercised directly with a supplied context block (runAiAction.js's
// `review_probe` task) instead of only ever as a side effect of a full build —
// without a second copy of this string drifting from the real one.
export function buildReviewPrompt({ contextBlock, chunk, allOps, plan, batchNote = '' }) {
  const opsBlock = chunk.map((op, i) =>
    `--- FILE ${i + 1}: ${op.path} (action: ${op.action || 'create'}) ---\n${op.content || '(empty)'}`
  ).join('\n\n');
  const planNote = plan ? `\n\nORIGINAL BUILD PLAN (for context):\n${plan}` : '';
  const manifest = allOps.length > REVIEW_CHUNK_SIZE
    ? `\n\nFULL FILE LIST IN THIS BUILD (for cross-file context only — most are reviewed in other batches): ${allOps.map((op) => op.path).join(', ')}`
    : '';
  return `${REVIEWER_PROMPT}\n${contextBlock}\n\nPROPOSED FILE OPERATIONS TO REVIEW:\n${opsBlock}${planNote}${manifest}${batchNote}\n\nReview these files now.`;
}

export const REVIEW_SCHEMA = {
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
};

// 2026-09-03, round three: raising this cap (3000 -> 6000) was still not
// enough — Rob hit the identical OUTPUT_TRUNCATED after a real ~7-minute
// build, because this call used to review ALL of a build's accumulated
// fileOps in ONE completion. That's the exact same "unbounded multi-file
// output in a single call" shape as the old Coder bug — a big enough build
// (many Coder chunks' worth of files, each contributing issues + a message)
// will always eventually blow through whatever fixed number is picked here.
// Rather than raise the number again and wait for round four, this now
// reviews a few files per call and merges the results — the same chunking
// fix already applied to the Coder (see chatWithMorpheus.js / chunkedFileGen.js).
//
// 2026-09-03, round four: the chunked version above STILL truncated
// (maxTokens=8000, 5 files/batch) — 5 real files' worth of content read by
// the model plus a full critical/warning issue list for each is more
// output than 8000 tokens covers once files aren't trivially small. Rather
// than raise the number a fourth time on its own, this shrinks the batch
// too, matching the Coder's own economics (chatWithMorpheus.js /
// chunkedFileGen.js use 3 files/step at a much higher per-step cap) instead
// of assuming review output is cheap just because it's shorter than the
// code it's reviewing.
const REVIEW_CHUNK_SIZE = 3;
export const REVIEW_STEP_MAX_TOKENS = 16000; // generous for up to 3 files' worth of issues

// `progress` (optional, 5th arg) — 2026-09-03 (Rob: stream step-by-step
// progress + an ETA in the chat window): { onProgress, stageName }. When
// given, onProgress({stage: stageName, status: 'start'|'done'}) fires around
// the invokeAI call(s) below so a streaming caller (chatWithMorpheus.js) can
// emit a real progress event; every existing positional caller (only 4
// args) just gets undefined here and onProgress?.() is a no-op, so nothing
// else needs to change.
export async function reviewFileOperations(userId, fileOps, contextBlock, plan, progress) {
  const { onProgress, stageName = 'reviewer', budget = null, reserveCalls = 0 } = progress || {};

  const chunks = [];
  for (let i = 0; i < fileOps.length; i += REVIEW_CHUNK_SIZE) {
    chunks.push(fileOps.slice(i, i + REVIEW_CHUNK_SIZE));
  }

  onProgress?.({ stage: stageName, status: 'start' });

  const allIssues = [];
  const summaries = [];
  let approvedAll = true;
  let model, provider;

  // WHICH CALLS THIS PASS WILL MAKE, decided up front by the budget — so the ceiling is arithmetic a test
  // can count, not a guard clause someone has to notice. Chunks beyond it are recorded as unreviewed, never
  // treated as reviewed-and-fine.
  const planned = planReviewCalls(chunks, budget, { reserve: budget ? reserveCalls : 0 });
  const reviewed = [];
  const skipped = [...planned.unreviewed];

  // ⚠️ THE CHUNKS ARE REVIEWED AT ONCE, BOUNDED, AND THE RESULTS COME BACK IN CHUNK ORDER.
  //
  // This loop used to be sequential, and the reviewer is the slowest call in the system — measured at 45.4s a call,
  // with `REVIEW_CHUNK_SIZE` of 3 files, so a seven-file build spent ~136s in the reviewer and every one of those
  // seconds was on the critical path of the whole build. The chunks are genuinely INDEPENDENT: each is handed its
  // own files, the same context block, the same rules, and the full list only as a read-only manifest. Nothing in
  // one chunk's answer can change another's — unlike the coder's chunks, where a later file can contradict an
  // earlier one — so this is a scheduling change and nothing else. The model (pro @ 0.4), the context and the
  // prompt are all untouched, which is what keeps the decisions in MODEL-DECISIONS.md intact: **the reviewer's
  // safety net is not narrowed by running its chunks in parallel, only its wall-clock.**
  //
  // The order still matters and is preserved. `allIssues` and `summaries` are read in sequence by the operator and
  // were ordered by chunk before; `mapWithConcurrency` returns one entry per chunk, by chunk index, so the
  // accumulation below is byte-for-byte the same sequence the sequential loop produced. `approvedAll` is an AND
  // fold and order-free either way.
  //
  // A failing chunk still ends the review with an error — the pool reports the FIRST failing chunk in order rather
  // than whichever call failed fastest, so the error an operator sees does not depend on network timing.
  const perChunk = await mapWithConcurrency(planned.willReview, maxConcurrentCalls(), async (chunk) => {
    const batchNote = chunks.length > 1
      ? `\n\nReviewing batch of ${chunk.length} file(s) out of ${fileOps.length} total in this build.`
      : '';
    const review = await invokeAI({
      userId,
      prompt: buildReviewPrompt({ contextBlock, chunk, allOps: fileOps, plan, batchNote }),
      schema: REVIEW_SCHEMA,
      fileUrls: undefined,
      role: 'reviewer',
      // The call-site label. `stageName` is 'reviewer' for a first pass and 'retry_reviewer' after a fix, so a
      // usage row can finally say WHICH of the two it was — the distinction that was invisible when 4,956 of
      // 4,983 rows carried no task at all, and the reason an earlier reading of this role's cost was wrong.
      task: stageName,
      maxTokens: REVIEW_STEP_MAX_TOKENS,
    });
    return {
      paths: chunk.map((op) => op.path),
      model: review.model,
      provider: review.provider,
      issues: Array.isArray(review.result.issues) ? review.result.issues : [],
      summary: review.result.summary,
      approved: review.result.approved,
    };
  });

  for (const r of perChunk) {
    reviewed.push(...r.paths);
    model = r.model;
    provider = r.provider;
    allIssues.push(...r.issues);
    if (r.summary) summaries.push(r.summary);
    if (r.issues.some((i) => i.severity === 'critical') || !r.approved) approvedAll = false;
  }

  onProgress?.({ stage: stageName, status: 'done' });

  const criticalIssues = allIssues.filter((i) => i.severity === 'critical');
  // A review that stopped early may not claim approval — see reviewBudget.js. `unreviewed` travels with
  // the result so the caller can say which files were never examined instead of implying they passed.
  const outcome = reviewOutcome({ reviewedPaths: reviewed, unreviewedPaths: skipped, approved: approvedAll && criticalIssues.length === 0, budget });
  return {
    issues: allIssues,
    summary: summaries.join(' ') || (outcome.partial ? outcome.note : 'Review complete.'),
    approved: outcome.approved,
    partial: outcome.partial,
    unreviewed: outcome.unreviewedPaths,
    provider,
    model,
  };
}

// Format the review outcome for the Morpheus chat. Critical issues are
// emitted on lines prefixed with a marker the chat UI renders in red, so
// the operator can spot what still needs fixing at a glance. Warnings are
// omitted from the chat to keep it readable — only blockers surface.
export function formatReviewChatBlock(review) {
  const critical = review.issues.filter(i => i.severity === 'critical');
  const lines = [];
  if (review.summary) lines.push(`// REVIEW: ${review.summary}`);
  if (critical.length > 0) {
    lines.push(`// CRITICAL ISSUES (${critical.length}):`);
    for (const c of critical) lines.push(`// CRITICAL: ${c.path}: ${c.message}`);
  }
  return lines.join('\n');
}

// Build the feedback prompt for a coder retry after review found issues.
export function buildRetryPrompt(fileOps, review, plan) {
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
// `onProgress` (optional, 6th arg) — see reviewFileOperations' comment above.
// Fires { stage, status } for 'reviewer' (the initial review), and — only on
// the critical-issue retry path — 'retry_coder' and 'retry_reviewer' too, so
// a streaming caller can show each real step instead of one opaque "review"
// phase. Every existing caller (5 args) leaves this undefined; harmless.
export async function reviewAndRetry(userId, fileOps, contextBlock, plan, coderPrompt, onProgress) {
  if (fileOps.length === 0) return { fileOps, reviewed: false, approved: true, issues: [] };

  // ONE budget for the whole operation, shared by the first pass and every re-review. Per-pass budgets
  // would let three passes each spend the ceiling, which is exactly how twelve calls happened. Created
  // BEFORE the first review so that pass can reserve the re-review's call.
  const budget = createReviewBudget();

  // Always deduplicate by path (last wins) — the LLM sometimes returns both
  // "package.json" and "backend/package.json" which map to the same path.
  const byPath = new Map(fileOps.map(op => [op.path, op]));
  let currentOps = Array.from(byPath.values());

  // The FIRST pass reserves the re-review's call. Without it the ceiling is spent before the fix is
  // checked, and the review's own demand goes unverified — measured 2026-09-30.
  let review = await reviewFileOperations(userId, currentOps, contextBlock, plan, {
    onProgress, stageName: 'reviewer', budget, reserveCalls: REVIEW_BUDGET.reserveForReReview,
  });

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

  // How much rework did this change actually need? Counted, because the only
  // evidence anyone had was that reviewer calls outnumber coder calls 1.8:1 —
  // which is equally consistent with "review catches a lot" and "the coder
  // usually needs a second pass", and those point at opposite fixes.
  let coderFixAttempts = 0;
  const firstReviewHadCritical = review.issues.some((i) => i.severity === 'critical');
  for (let attempt = 1; !review.approved && review.issues.some(i => i.severity === 'critical') && attempt < MAX_REVIEW_ATTEMPTS; attempt++) {
    const passAllowed = canStartReReviewPass(budget);
    const callsLeft = canSpendReviewCall(budget);
    if (!passAllowed.ok || !callsLeft.ok) {
      // REPORTED, not silent. The loop stops with critical issues outstanding and says so, so the caller
      // can tell the operator the change was partially fixed rather than implying it converged.
      review.stoppedBecause = passAllowed.reason || callsLeft.reason;
      console.log(`[reviewer] stopping the fix/re-review loop: ${review.stoppedBecause}`);
      break;
    }
    coderFixAttempts++;
    onProgress?.({ stage: 'retry_coder', status: 'start' });
    const retry = await invokeAI({
      userId,
      prompt: `${coderPrompt}\n\n${buildRetryPrompt(currentOps, review, plan)}\n\n(Fix attempt ${attempt} of ${MAX_REVIEW_ATTEMPTS - 1}.)`,
      schema: retrySchema,
      fileUrls: undefined,
      role: 'coder',
      // 2026-09-03 correction: same fix as chatWithMorpheus.js's Coder/polish
      // calls — going uncapped didn't actually remove the ceiling, it just
      // handed control to DeepSeek's own undocumented default max_tokens
      // (this deployment runs deepseek-v4-pro), which truncated sooner than
      // the old 18000 cap did. Explicitly requesting 64000 (well inside
      // v4-pro's real 384K output ceiling) instead of omitting the param.
      maxTokens: 64000,
    });
    onProgress?.({ stage: 'retry_coder', status: 'done' });
    const corrected = Array.isArray(retry.result.fileOperations) ? retry.result.fileOperations : [];
    for (const c of corrected) {
      if (c.path) byPath.set(c.path, c);
    }
    currentOps = Array.from(byPath.values());
    startReReviewPass(budget);
    // Re-review ONLY what the fix could have changed. The retry prompt asks the coder to re-output the
    // files with issues and nothing else, so every other file is byte-for-byte what the previous review
    // already saw — re-examining it cannot change its verdict and only buys the same answer twice.
    // Measured 2026-09-30: the whole-set re-review is what made one generation cost twelve reviewer calls.
    const scope = reReviewScope(review.issues.filter((i) => i.severity === 'critical'), currentOps.map((op) => op.path));
    const scopedOps = currentOps.filter((op) => scope.paths.includes(op.path));
    console.log(`[reviewer] re-reviewing ${scopedOps.length}/${currentOps.length} file(s) — ${scope.reason}`);
    review = await reviewFileOperations(
      userId,
      scopedOps.length > 0 ? scopedOps : currentOps,
      contextBlock,
      plan,
      { onProgress, stageName: 'retry_reviewer', budget },
    );
  }

  return {
    fileOps: currentOps,
    // Rework attribution: how many coder fix passes the reviewer demanded, and
    // whether the FIRST review found anything critical at all. The caller puts
    // this in the turn's result, so it reaches the durable run record.
    attempts: coderFixAttempts,
    criticalFound: firstReviewHadCritical,
    reviewerModel: review.model,
    reviewSummary: review.summary,
    reviewed: true,
    approved: review.approved,
    // Whether part of the change went UNREVIEWED because the budget stopped the loop. The caller must be
    // able to say so; silence here would read as "reviewed and fine".
    partial: Boolean(review.partial),
    unreviewed: review.unreviewed || [],
    reviewCalls: budget.callsUsed,
    stoppedBecause: review.stoppedBecause || null,
    issues: review.issues
  };
}
