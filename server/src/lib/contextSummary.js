// Rolling summary of a project's older conversation history — restores
// long-term memory for long-lived projects without resending the entire,
// ever-growing chat history on every AI call. See chatWithMorpheus.js /
// autonomousBuildStep.js: recent messages are always sent verbatim, bounded
// to the last 20 / 10 messages (matches the original app — see the
// 2026-08-26 audit for why unbounded history was reverted). Everything
// older than that window would otherwise just be forgotten; this module is
// what keeps it from being lost entirely.
//
// How it works: not on every message (that would double AI-call cost per
// turn, working against the same "scale to millions of users" goal the
// bounded window protects) — only every SUMMARY_UPDATE_INTERVAL messages
// once the project has grown past the recent window, one AI call condenses
// the newly-aged-out messages into a short "critical logic" summary
// (requirements, architecture decisions, things explicitly rejected,
// established conventions) and folds it into the existing summary, so the
// stored summary stays a single bounded document rather than growing
// unbounded itself. Summarization failure never blocks a build — it just
// falls back to whatever summary already exists (or none).
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { logUsage } from './projectUtils.js';

export const HISTORY_WINDOW = { chat: 20, autonomous: 10 };
const SUMMARY_UPDATE_INTERVAL = 15; // fold in a new batch every N messages past the window
const MAX_SUMMARY_WORDS = 300;

const SUMMARY_PROMPT = `You maintain a compact running memory for an AI coding assistant working on a long-lived software project across many chat turns. You will be given the EXISTING SUMMARY (may be empty, for a new project) and a BATCH OF OLDER MESSAGES that have just aged out of the assistant's recent-context window.

Produce an UPDATED summary that folds the batch into the existing one. Keep ONLY what a coding assistant genuinely needs to remember later:
- Explicit requirements and constraints the operator stated
- Architecture / technology / library decisions and the reasoning, if given
- Anything the operator explicitly rejected, forbade, or asked to undo
- Naming, style, or structural conventions established for this project
- Unresolved questions or TODOs the operator raised but didn't resolve

Drop anything superseded by a later decision in the batch. Drop small talk, acknowledgments, and anything already fully reflected in the current project files (you are not shown the files — assume ordinary implementation details are, and only keep decisions/constraints, not routine progress narration). Be terse — dense bullet points, no prose padding. Target under ${MAX_SUMMARY_WORDS} words total regardless of how large the existing summary or batch is; compress harder, don't just append.

Return JSON with:
- summary: the complete updated summary text (replaces the existing one entirely)`;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string', description: `Updated running summary, under ${MAX_SUMMARY_WORDS} words` } },
};

/**
 * Returns the context summary to inject into this turn's prompt, updating
 * it first (one extra AI call) if enough new messages have accumulated
 * past the recent-history window since it was last refreshed. Cheap in the
 * common case: most turns make zero extra AI calls and just return the
 * project's already-stored summary field.
 *
 * @param {string} userId
 * @param {object} project - the Prisma Project row (must include id,
 *   context_summary, context_summary_message_count)
 * @param {'chat'|'autonomous'} windowKind - which bounded recent-message
 *   window this caller uses, so the summary only folds in messages that
 *   have actually fallen out of view
 * @returns {Promise<string>} the current (possibly just-updated) summary,
 *   or '' if there's nothing to summarize yet
 */
export async function getContextSummary(userId, project, windowKind) {
  const window = HISTORY_WINDOW[windowKind] || HISTORY_WINDOW.chat;
  const totalCount = await prisma.chatMessage.count({ where: { project_id: project.id, created_by_id: userId } });
  const alreadySummarized = project.context_summary_message_count || 0;
  const pending = totalCount - window - alreadySummarized;

  if (pending < SUMMARY_UPDATE_INTERVAL) {
    return project.context_summary || '';
  }

  // Fold in everything older than the current recent-window that hasn't
  // been summarized yet — could be more than one interval's worth if the
  // project jumped in message count (e.g. an import), so summarize it all
  // in one pass rather than looping; the prompt already asks for
  // compression, not concatenation, so one larger batch is fine.
  const batchSize = totalCount - window - alreadySummarized;
  const batch = await prisma.chatMessage.findMany({
    where: { project_id: project.id, created_by_id: userId },
    orderBy: { created_date: 'asc' },
    skip: alreadySummarized,
    take: batchSize,
  });
  if (batch.length === 0) return project.context_summary || '';

  const batchText = batch.map((m) => `${m.role === 'user' ? 'Operator' : 'Morpheus'}: ${m.content}`).join('\n');
  const existing = project.context_summary || '(none yet — this is the first summarization pass)';

  try {
    const { result } = await invokeAI({
      userId,
      prompt: `${SUMMARY_PROMPT}\n\nEXISTING SUMMARY:\n${existing}\n\nBATCH OF OLDER MESSAGES TO FOLD IN:\n${batchText}`,
      schema: SUMMARY_SCHEMA,
      role: 'diagnosis', // reuse the diagnosis role slot: same "analyze, don't build" shape,
                          // and operators can already point LLM_DIAGNOSIS_MODEL at something
                          // cheaper/faster without this needing its own role/env var.
      // 2026-09-03 audit: output here is deliberately a compressed summary
      // (the prompt asks for compression, not concatenation) so it should
      // stay naturally short, but it had no explicit cap either — closing
      // the same gap as every other call site found this pass.
      maxTokens: 4000,
    });
    const newSummary = (result?.summary || existing).trim();
    await prisma.project.update({
      where: { id: project.id },
      data: { context_summary: newSummary, context_summary_message_count: alreadySummarized + batch.length },
    });
    // Transparent, accurate usage accounting — this is a real extra AI call
    // (billable at scale), not a side effect of the chat/autonomous action
    // that triggered it, so it gets its own usage record rather than being
    // silently folded into the caller's.
    await logUsage(userId, 'context_summary', project.id, project.name, { messagesFolded: batch.length });
    return newSummary;
  } catch (e) {
    // A context-quality enhancement, never a build blocker — fall back to
    // whatever summary already exists (possibly none) and let the bounded
    // recent-message window carry the turn on its own.
    console.error('contextSummary: update failed, continuing without it:', e.message);
    return project.context_summary || '';
  }
}

// Formats the summary (if any) as a labeled block ready to splice into a
// prompt's context section. Returns '' when there's nothing to show, so
// callers can unconditionally concatenate it with no blank-block artifact.
export function formatContextSummaryBlock(summary) {
  if (!summary) return '';
  return `\n\nEARLIER IN THIS PROJECT (summary of older messages, condensed for context — the requirements and decisions below still apply even though the original messages aren't shown):\n${summary}`;
}
