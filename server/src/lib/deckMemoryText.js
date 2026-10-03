// The Deck's memory fold, as pure decisions: what the model is allowed to change, and how
// the change is applied to the stored memory.
// WHY THIS IS ITS OWN MODULE
//
// `MEMORY_SCHEMA` does not mark `memory` as required, and `invokeAI` only guarantees
// that the JSON parsed — so `{}` is a reachable, valid answer. The fold used to keep the
// old content while still advancing `folded_message_count` by the batch size, marking
// those turns as folded when they had never been folded; the caller skips
// `alreadyFolded`, so they were never offered again. A silent, permanent hole in the
// memory the whole Deck reasons over, and no log line mentioned it.
//
// Import-free on purpose, like deckDumpClassify / deckInsightGate / deckInsightPayload:
// `scripts/verify-deck-memory.mjs` runs in CI's no-install guards job, where importing
// `deckMemory.js` would drag in Prisma, S3 and the AI gateway and the guard could not
// run at all. A guard that cannot run is not a pass.
//
// ── 2026-10-04: THE FOLD STOPPED ASKING THE MODEL TO COMPOSE ─────────────────────────────────────
//
// Measured in production: **131 of the last 200 `diagnosis` rows sat at EXACTLY 4000 tokens**, the
// truncation signature this repo has paid for repeatedly. `deckMemory.js` is the only
// `diagnosis`-role caller with that cap, so those are the fold. A truncated fold throws
// (`invokeAI` refuses a cut-off schema answer), the catch keeps the old memory and advances
// nothing, and the same batch comes back next time — so Jarvis's long-term memory was stalling
// roughly two times in three.
//
// The cause is structural, not a tight budget: the fold asked the model to WRITE OUT THE WHOLE
// MEMORY every time, so the output grew with the memory while a reasoning model's hidden thinking
// was billed against the same cap. Raising the cap is the documented WRONG fix (MODEL-DECISIONS.md
// records that mistake three times, and this file's own comment shows it had already been tried
// once). So the model no longer writes memory at all — it **selects**: lines to ADD, and existing
// lines to DROP. The compose step happens here, in code, where it cannot truncate. The output is a
// dozen short strings regardless of how large the memory or the batch has become.

/** The stored memory as lines — blank ones dropped, order preserved (oldest first). */
export function memoryLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Rough word count, used only to enforce the size ceiling. */
export function memoryWordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * A model's answer to "what should change?", as two lists of strings.
 *
 * Anything unusable yields empty lists rather than throwing: a fold that changes nothing is a
 * wasted call, and a fold that throws would lose the batch.
 */
export function memoryEdit(result) {
  const list = (v) => (Array.isArray(v) ? v : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
  return { additions: list(result?.additions), removals: list(result?.removals) };
}

/**
 * Apply a model's edit to the stored memory. Pure, so every branch is testable with no model.
 *
 * THE SAFE DIRECTIONS, both deliberate:
 *
 *  - A `removal` that does not match an existing line removes NOTHING. The model may paraphrase, and
 *    losing a real memory to a near-miss is much worse than keeping a stale line.
 *  - An `addition` that duplicates an existing line (case-insensitively) is dropped, so a fold
 *    cannot grow the memory by restating it.
 *
 * The ceiling is enforced here rather than trusted: the prompt asks the model to keep the total
 * small, and if it does not, the OLDEST lines go. That is a real loss, so it is last-resort only —
 * but an unbounded memory would be interpolated into every Jarvis prompt, which is the one outcome
 * worse than forgetting an old line.
 *
 * @param {string} existingText the stored memory
 * @param {{additions?: string[], removals?: string[]}} edit
 * @param {{maxWords?: number}} [options]
 * @returns {string}
 */
export function applyMemoryEdit(existingText, edit, { maxWords = 400 } = {}) {
  const { additions, removals } = memoryEdit(edit);
  const removalsLower = new Set(removals.map((r) => r.toLowerCase()));

  let lines = memoryLines(existingText).filter((line) => !removalsLower.has(line.toLowerCase()));

  const seen = new Set(lines.map((l) => l.toLowerCase()));
  for (const addition of additions) {
    const key = addition.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(addition);
  }

  // Ceiling: drop the oldest until it fits. Word-counted, because that is the unit the prompt and
  // MAX_MEMORY_WORDS are written in.
  while (lines.length > 1 && memoryWordCount(lines.join('\n')) > maxWords) lines.shift();

  return lines.join('\n');
}
