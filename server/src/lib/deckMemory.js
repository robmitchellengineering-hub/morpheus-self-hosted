// Jarvis's real long-term memory. chatWithJarvis.js already sends the last
// HISTORY_WINDOW turns verbatim as recent conversation — everything older
// than that would otherwise just be forgotten, which defeats the point for
// someone with executive dysfunction who needs Jarvis to actually connect
// dots across weeks, not just the last dozen messages. Same "fold in what
// aged out" mechanism lib/contextSummary.js already uses for build chats
// (see that file's own comment for the full reasoning), scoped here to
// DeckJarvisMessage instead of ChatMessage/Project.
//
// Also mirrored into the user's own Drive (jarvis-memory.md, in the same
// folder backupDeckToDrive.js uses) so this memory is genuinely durable and
// theirs — readable, exportable, outliving this deployment's Postgres row —
// not just trapped in Morpheus. The Drive mirror is best-effort and never
// blocks a chat turn: if it's not connected yet, or the write fails, Jarvis
// still has the Postgres copy.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { memoryLines, applyMemoryEdit } from './deckMemoryText.js';
import { getDeckGoogleConnection, DECK_BACKUP_FOLDER_NAME } from './deckGoogle.js';
import { createDriveFolder, listDriveFolderFiles, createDriveFile, updateDriveFileContent } from './googleDrive.js';
import { getDeckBusinessContext } from './deckBusinessProfile.js';

export const HISTORY_WINDOW = 12; // must match chatWithJarvis.js's recent-turn window
const MEMORY_UPDATE_INTERVAL = 8; // fold in a new batch every N messages past the window
const MAX_MEMORY_WORDS = 400;
const MEMORY_FILE_NAME = 'jarvis-memory.md';

// 2026-09-17: parameterized (was hardcoded "Rob ... someone with ADHD who
// runs Valiant Music") so the same memory-folding mechanism works for any
// account.
// 2026-10-04 — THE PROMPT NO LONGER ASKS FOR THE WHOLE MEMORY BACK.
//
// It asked the model to WRITE OUT the updated memory every time, so the output grew with the memory
// while a reasoning model's hidden thinking was billed against the same cap: 131 of the last 200
// folds sat at exactly 4000 tokens, threw on truncation, and stored nothing. The model now SELECTS
// instead of composes — lines worth adding, and existing lines that are no longer true — and
// `applyMemoryEdit` does the splice in code where it cannot truncate. The answer is a dozen short
// strings no matter how large the memory or the batch has become.
function buildMemoryPrompt({ firstName, businessContext }) {
  return `You maintain Jarvis's long-term memory of ${firstName}, who runs ${businessContext}. You will be given the EXISTING MEMORY as numbered lines (may be empty, first pass) and a BATCH OF OLDER CONVERSATION TURNS that have just aged out of Jarvis's recent-context window.

You do NOT rewrite the memory. You return only two lists.

ADDITIONS — new lines worth remembering that the existing memory does not already say. Keep ONLY what genuinely helps Jarvis connect dots later that ${firstName} might not connect themself:
- Real patterns across time (energy/mood cycles, what they avoid and why, what actually works for them)
- Recurring people, commitments, and relationships worth remembering
- Decisions they've made and the reasoning, so Jarvis doesn't re-litigate settled things
- Things they said they wanted (goals, changes, intentions) and whether they've since acted on them
- Anything said once that would be genuinely useful to recall weeks later

Write each addition as ONE short, dense line — a fact, not prose. No padding, no restating the batch.

REMOVALS — existing lines that the batch has made false or superseded, copied WORD FOR WORD from the numbered list. A line that is still true stays. When you are unsure, keep it: a stale line costs a little, a deleted true memory costs a lot.

Do NOT add small talk, anything already reflected in the live Deck snapshot (tasks/notes/etc — Jarvis sees that fresh every turn already), or a long description of an attached file's contents; at most note what it was and why it mattered. Keep the total under ${MAX_MEMORY_WORDS} words — the existing lines plus your additions — so remove more if the memory is near its ceiling.

Return JSON with:
- additions: array of new lines (empty array if the batch adds nothing worth keeping)
- removals: array of existing lines to delete, exactly as written above (empty array if none)`;
}

const MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    additions: { type: 'array', items: { type: 'string' }, description: 'New memory lines to append. Empty when the batch adds nothing worth keeping.' },
    removals: { type: 'array', items: { type: 'string' }, description: 'Existing memory lines to delete, copied exactly from the numbered list. Empty when none.' },
  },
  required: ['additions', 'removals'],
};

async function mirrorToDrive(userId, content) {
  const connection = await getDeckGoogleConnection(userId);
  if (!connection?.token) return; // not connected — memory still works, just Postgres-only until they connect Google

  let row = await prisma.deckGoogleConnection.findUnique({ where: { created_by_id: userId }, select: { backup_folder_id: true } });
  let folderId = row?.backup_folder_id;
  if (!folderId) {
    folderId = await createDriveFolder(connection.token, DECK_BACKUP_FOLDER_NAME);
    await prisma.deckGoogleConnection.update({ where: { created_by_id: userId }, data: { backup_folder_id: folderId } });
  }

  const existing = (await listDriveFolderFiles(connection.token, folderId)).find((f) => f.name === MEMORY_FILE_NAME);
  if (existing) await updateDriveFileContent(connection.token, existing.id, content, 'text/markdown');
  else await createDriveFile(connection.token, { name: MEMORY_FILE_NAME, parentId: folderId, content, mimeType: 'text/markdown' });
}

// Returns the current long-term memory to inject into this turn's prompt,
// updating it first (one extra AI call, plus a best-effort Drive write) if
// enough turns have accumulated past the recent-history window since it was
// last refreshed. Cheap in the common case: most turns make zero extra AI
// calls and just return the already-stored memory content.
export async function getJarvisMemory(userId) {
  const row = await prisma.deckJarvisMemory.findUnique({ where: { created_by_id: userId } });
  const existingContent = row?.content || '';
  const alreadyFolded = row?.folded_message_count || 0;

  const totalCount = await prisma.deckJarvisMessage.count({ where: { created_by_id: userId } });
  const pending = totalCount - HISTORY_WINDOW - alreadyFolded;

  if (pending < MEMORY_UPDATE_INTERVAL) {
    return existingContent;
  }

  // Fold in everything older than the current recent-window that hasn't
  // been folded yet, in one pass — the prompt already asks for compression,
  // not concatenation, so a larger batch is fine.
  const batchSize = totalCount - HISTORY_WINDOW - alreadyFolded;
  const batch = await prisma.deckJarvisMessage.findMany({
    where: { created_by_id: userId },
    orderBy: { created_date: 'asc' },
    skip: alreadyFolded,
    take: batchSize,
  });
  if (batch.length === 0) return existingContent;

  // Only fetched on the (uncommon) fold path, not the fast-path return above.
  const [userRow, businessContext] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { full_name: true } }),
    getDeckBusinessContext(userId),
  ]);
  const firstName = (userRow?.full_name || '').trim().split(/\s+/)[0] || 'the account owner';

  const batchText = batch.map((m) => `${m.role === 'user' ? firstName : 'Jarvis'}: ${m.content}`).join('\n');
  // Numbered, because REMOVALS are copied back word for word from this list — the model is choosing
  // among lines it can see, not recalling them.
  const existingLines = memoryLines(existingContent);
  const numbered = existingLines.length
    ? existingLines.map((line, i) => `${i + 1}. ${line}`).join('\n')
    : '(none yet — first pass)';

  try {
    const { result } = await invokeAI({
      userId,
      prompt: `${buildMemoryPrompt({ firstName, businessContext })}\n\nEXISTING MEMORY:\n${numbered}\n\nBATCH OF OLDER TURNS TO FOLD IN:\n${batchText}`,
      schema: MEMORY_SCHEMA,
      role: 'diagnosis', // "analyze, don't build" shape — same reuse as contextSummary.js
      // 2026-10-04: NOT raised, deliberately. The old shape asked the model to compose the whole
      // memory, so its output grew with the memory while the hidden-reasoning tax ate the same
      // budget and 65% of folds truncated. A bigger cap is the recorded wrong fix
      // (MODEL-DECISIONS.md, three instances). The output is now a dozen short strings, so this
      // budget is the model's thinking room and nothing else.
      maxTokens: 4000,
    });

    // An empty edit is a SUCCESSFUL fold that decided the batch added nothing — which must advance
    // `folded_message_count`, or the same batch comes back forever. Only a throw (below) leaves it
    // unadvanced, because only a throw means we do not know what the batch contained.
    const returned = applyMemoryEdit(existingContent, result, { maxWords: MAX_MEMORY_WORDS });
    if (!returned && existingContent) {
      // The edit emptied the memory. `applyMemoryEdit` cannot do that on its own (it keeps the last
      // line), so this means the model asked to remove everything — refuse, and say so rather than
      // wiping what Jarvis knows on one bad answer.
      console.warn('[deckMemory] the edit would have emptied the memory; keeping the existing content and leaving folded_message_count alone');
      return existingContent;
    }

    await prisma.deckJarvisMemory.upsert({
      where: { created_by_id: userId },
      create: { created_by_id: userId, content: returned, folded_message_count: alreadyFolded + batch.length },
      update: { content: returned, folded_message_count: alreadyFolded + batch.length },
    });

    mirrorToDrive(userId, returned).catch((err) => {
      console.error('[deckMemory] Drive mirror failed, continuing with the Postgres copy only:', err.message);
    });

    return returned;
  } catch (e) {
    // A context-quality enhancement, never a chat blocker — fall back to
    // whatever memory already exists (possibly none) and let the recent
    // rolling window carry the turn on its own.
    console.error('[deckMemory] update failed, continuing without it:', e.message);
    return existingContent;
  }
}

// Formats the memory (if any) as a labeled block ready to splice into a
// prompt. Returns '' when there's nothing yet, so callers can unconditionally
// concatenate it with no blank-block artifact.
export function formatMemoryBlock(memory) {
  if (!memory) return '';
  return `\n\nLONG-TERM MEMORY (condensed from earlier conversations — still true unless something below says otherwise):\n${memory}`;
}
