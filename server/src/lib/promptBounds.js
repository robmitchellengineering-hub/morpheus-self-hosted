// The two blocks in Jarvis's prompt that could grow without limit, and the rules that stop them.
//
// WHY (2026-09-27, measured): the reply's prompt is 94% persona + memory + snapshot +
// conversation, and every one of those is evidence for the questions Jarvis is asked — so there
// is nothing to "trim" without losing signal. What was missing was a BOUND. Two blocks had none:
//
//   * the conversation is limited to 12 messages (`HISTORY_WINDOW`, deliberately coupled to the
//     memory fold cadence), but each entry can be a full reply of up to MAX_REPLY_TOKENS (6000
//     tokens) — twelve of those is ~60k input tokens on one message, and the block has already
//     grown 77 -> 6,927 characters in production through Jarvis's own verbosity;
//   * the inbox is where "the opportunity he has not seen" lives, so it must stay in the prompt —
//     but its bodies are free text, and it is the largest single block (two rows were 52% of the
//     snapshot's characters). Unlike the consignment line, they ARE evidence, so they cannot be
//     dropped; they can be bounded.
//
// The rules, both chosen so Jarvis is never told something untrue:
//   * the last user message and the last reply are ALWAYS verbatim — that is what "what did we
//     just say" means, and a summary of it would answer a different question;
//   * older turns are kept newest-first while they fit a character budget, each sliced;
//   * when anything is left out, the block SAYS how many turns, so the model cannot conclude the
//     conversation began later than it did. The same for the inbox: the true open count is always
//     stated, so a capped list never reads as the whole picture.
//
// Pure and import-free, so scripts/verify-deck-prompt-bounds.mjs can assert every case with no
// server, no database and no model.

export const CONVERSATION_MAX_CHARS = 12000;
export const CONVERSATION_PER_MESSAGE_CHARS = 1500;
export const INBOX_IN_PROMPT = 25;
export const REPAIRS_IN_PROMPT = 25;
export const INBOX_EXCERPT_CHARS = 200;

/** "text…" when cut, with the cut marked; the trimming is visible, never silent. */
export function excerpt(text, limit = INBOX_EXCERPT_CHARS) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/**
 * The recent-conversation block for the reply prompt.
 *
 * @param {Array<{role: string, content: string}>} history chronological, oldest first
 * @returns {string}
 */
export function buildConversationBlock(history, { firstName = 'You', maxChars = CONVERSATION_MAX_CHARS, perMessageChars = CONVERSATION_PER_MESSAGE_CHARS } = {}) {
  const msgs = (Array.isArray(history) ? history : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim());
  if (!msgs.length) return '(no prior conversation)';

  const label = (m) => `${m.role === 'user' ? firstName : 'Jarvis'}: `;
  const alwaysWhole = new Set([msgs.length - 1, msgs.length - 2].filter((i) => i >= 0));

  const lines = [];
  let used = 0;
  let omitted = 0;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const text = msgs[i].content.trim();
    // The last exchange is kept whole however large it is: dropping or summarising it would
    // answer the wrong question, which is the failure this whole file exists to avoid.
    const line = alwaysWhole.has(i) || text.length <= perMessageChars
      ? `${label(msgs[i])}${text}`
      : `${label(msgs[i])}${text.slice(0, perMessageChars)}…[truncated]`;
    if (!alwaysWhole.has(i) && used + line.length > maxChars) { omitted = i + 1; break; }
    lines.unshift(line);
    used += line.length + 1;
  }
  if (omitted > 0) {
    lines.unshift(`(…${omitted} older turn${omitted === 1 ? '' : 's'} left out to bound the prompt)`);
  }
  return lines.join('\n');
}
