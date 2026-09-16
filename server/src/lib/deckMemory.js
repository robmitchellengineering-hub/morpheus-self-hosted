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
import { getDeckGoogleConnection, DECK_BACKUP_FOLDER_NAME } from './deckGoogle.js';
import { createDriveFolder, listDriveFolderFiles, createDriveFile, updateDriveFileContent } from './googleDrive.js';

export const HISTORY_WINDOW = 12; // must match chatWithJarvis.js's recent-turn window
const MEMORY_UPDATE_INTERVAL = 8; // fold in a new batch every N messages past the window
const MAX_MEMORY_WORDS = 400;
const MEMORY_FILE_NAME = 'jarvis-memory.md';

const MEMORY_PROMPT = `You maintain Jarvis's long-term memory of Rob — someone with ADHD who runs Valiant Music. You will be given the EXISTING MEMORY (may be empty, first pass) and a BATCH OF OLDER CONVERSATION TURNS that have just aged out of Jarvis's recent-context window.

Produce an UPDATED memory that folds the batch into the existing one. Keep ONLY what genuinely helps Jarvis connect dots later that Rob, given executive dysfunction, might not connect himself:
- Real patterns across time (energy/mood cycles, what he avoids and why, what actually works for him)
- Recurring people, commitments, and relationships worth remembering
- Decisions he's made and the reasoning, so Jarvis doesn't re-litigate settled things
- Things he said he wanted (goals, changes, intentions) and whether he's since acted on them
- Anything said once that would be genuinely useful to recall weeks later

Drop small talk, anything already fully reflected in the live Deck snapshot (tasks/notes/etc — Jarvis sees that fresh every turn already), and anything superseded by a later turn in the batch. Be terse — dense notes, no prose padding. Target under ${MAX_MEMORY_WORDS} words total regardless of how large the existing memory or batch is; compress harder, don't just append.

Return JSON with:
- memory: the complete updated memory text (replaces the existing one entirely)`;

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

  const batchText = batch.map((m) => `${m.role === 'user' ? 'Rob' : 'Jarvis'}: ${m.content}`).join('\n');

  try {
    const { result } = await invokeAI({
      userId,
      prompt: `${MEMORY_PROMPT}\n\nEXISTING MEMORY:\n${existingContent || '(none yet — first pass)'}\n\nBATCH OF OLDER TURNS TO FOLD IN:\n${batchText}`,
      schema: MEMORY_SCHEMA,
      role: 'diagnosis', // "analyze, don't build" shape — same reuse as contextSummary.js
      // Deliberately generous even though the target is a compressed 400
      // words — this deployment's model can burn real budget on hidden
      // reasoning before the actual JSON (the same lesson chatWithJarvis.js
      // and syncDeckGmailInbox.js's classifier both learned the hard way).
      maxTokens: 4000,
    });
    const newContent = (result?.memory || existingContent).trim();

    await prisma.deckJarvisMemory.upsert({
      where: { created_by_id: userId },
      create: { created_by_id: userId, content: newContent, folded_message_count: alreadyFolded + batch.length },
      update: { content: newContent, folded_message_count: alreadyFolded + batch.length },
    });

    mirrorToDrive(userId, newContent).catch((err) => {
      console.error('[deckMemory] Drive mirror failed, continuing with the Postgres copy only:', err.message);
    });

    return newContent;
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
