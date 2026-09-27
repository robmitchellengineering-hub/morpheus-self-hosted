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
import { usableMemoryText } from './deckMemoryText.js';
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
function buildMemoryPrompt({ firstName, businessContext }) {
  return `You maintain Jarvis's long-term memory of ${firstName}, who runs ${businessContext}. You will be given the EXISTING MEMORY (may be empty, first pass) and a BATCH OF OLDER CONVERSATION TURNS that have just aged out of Jarvis's recent-context window.

Produce an UPDATED memory that folds the batch into the existing one. Keep ONLY what genuinely helps Jarvis connect dots later that ${firstName} might not connect themself:
- Real patterns across time (energy/mood cycles, what they avoid and why, what actually works for them)
- Recurring people, commitments, and relationships worth remembering
- Decisions they've made and the reasoning, so Jarvis doesn't re-litigate settled things
- Things they said they wanted (goals, changes, intentions) and whether they've since acted on them
- Anything said once that would be genuinely useful to recall weeks later

Drop small talk, anything already fully reflected in the live Deck snapshot (tasks/notes/etc — Jarvis sees that fresh every turn already), and anything superseded by a later turn in the batch. If a turn mentions an attached file (photo, PDF, document — shown as "[attached: filename]"), keep at most a short reference to what it was and why it mattered, never a long description of its contents — Command Deck deliberately keeps this memory small. Be terse — dense notes, no prose padding. Target under ${MAX_MEMORY_WORDS} words total regardless of how large the existing memory or batch is; compress harder, don't just append.

Return JSON with:
- memory: the complete updated memory text (replaces the existing one entirely)`;
}

const MEMORY_SCHEMA = {
  type: 'object',
  properties: { memory: { type: 'string', description: `Updated long-term memory, under ${MAX_MEMORY_WORDS} words` } },
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

  try {
    const { result } = await invokeAI({
      userId,
      prompt: `${buildMemoryPrompt({ firstName, businessContext })}\n\nEXISTING MEMORY:\n${existingContent || '(none yet — first pass)'}\n\nBATCH OF OLDER TURNS TO FOLD IN:\n${batchText}`,
      schema: MEMORY_SCHEMA,
      role: 'diagnosis', // "analyze, don't build" shape — same reuse as contextSummary.js
      // Deliberately generous even though the target is a compressed 400
      // words — this deployment's model can burn real budget on hidden
      // reasoning before the actual JSON (the same lesson chatWithJarvis.js
      // and syncDeckGmailInbox.js's classifier both learned the hard way).
      maxTokens: 4000,
    });
    const returned = usableMemoryText(result);
    if (!returned) {
      // The schema does not mark `memory` as required, so a valid JSON object with no
      // usable text is reachable. This used to keep the old content AND advance
      // `folded_message_count` by the batch size, which marked those turns as folded
      // when they had never been folded — and the caller skips `alreadyFolded`, so they
      // were never offered again. A silent, permanent hole in the memory the whole Deck
      // reasons over. Advance nothing instead, so the batch comes back, and say so —
      // the same honesty the catch below already has.
      console.warn(`[deckMemory] the model returned no memory text; leaving folded_message_count at ${alreadyFolded} so this batch is folded again`);
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
