// The one decision the Deck's memory fold makes about a model response: is there
// usable memory text in it?
//
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

/** The usable memory text from a model response, or '' when there is none. */
export function usableMemoryText(result) {
  return typeof result?.memory === 'string' ? result.memory.trim() : '';
}
