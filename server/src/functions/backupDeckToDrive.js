// Command Deck's own Drive backup — gathers every Deck* entity as JSON and
// upserts one command-deck-backup.json in a "Command Deck Backup" Drive
// folder. Reuses lib/googleDrive.js's raw-fetch Drive helpers (already built
// for Feature Backlog #12) directly, just sourcing the token from
// getDeckGoogleToken instead of getGoogleDriveToken — see DeckGoogleConnection's
// schema.prisma comment for why this is a separate connection.
import { prisma } from '../db.js';
import { getDeckGoogleToken } from '../lib/deckGoogle.js';
import { createDriveFolder, listDriveFolderFiles, createDriveFile, updateDriveFileContent } from '../lib/googleDrive.js';

const BACKUP_FOLDER_NAME = 'Command Deck Backup';
const BACKUP_FILE_NAME = 'command-deck-backup.json';

// Same 14-entity set as CommandDeckContext.jsx's existing runExport() — kept
// identical so the Drive backup and the manual JSON export always cover the
// same data, not two subtly different notions of "everything".
export async function gatherDeckData(userId) {
  const where = { created_by_id: userId };
  const [
    dump, people, tasks, consignment, repairs, repairFiles, murbah, inbox,
    strategy, knowledge, lifeStreams, lifeStreamNotes, energyLog, focusLog,
  ] = await Promise.all([
    prisma.deckDumpItem.findMany({ where }),
    prisma.deckPerson.findMany({ where }),
    prisma.deckTask.findMany({ where }),
    prisma.deckConsignmentItem.findMany({ where }),
    prisma.deckRepairJob.findMany({ where }),
    prisma.deckRepairFile.findMany({ where }),
    prisma.deckMurbahOpportunity.findMany({ where }),
    prisma.deckInboxItem.findMany({ where }),
    prisma.deckStrategyNote.findMany({ where }),
    prisma.deckKnowledgeNote.findMany({ where }),
    prisma.deckLifeStream.findMany({ where }),
    prisma.deckLifeStreamNote.findMany({ where }),
    prisma.deckEnergyLogEntry.findMany({ where }),
    prisma.deckFocusEntry.findMany({ where }),
  ]);
  return {
    dump, people, tasks, consignment, repairs, repair_files: repairFiles, murbah, inbox,
    strategy, knowledge, life_streams: lifeStreams, life_stream_notes: lifeStreamNotes,
    energy_log: energyLog, focus_log: focusLog,
  };
}

export default async function handler({ user }) {
  const { token } = await getDeckGoogleToken(user.id);
  const connection = await prisma.deckGoogleConnection.findUnique({ where: { created_by_id: user.id } });

  let folderId = connection?.backup_folder_id;
  if (!folderId) {
    folderId = await createDriveFolder(token, BACKUP_FOLDER_NAME);
  }

  const data = await gatherDeckData(user.id);
  const content = JSON.stringify({ exported_at: new Date().toISOString(), data }, null, 2);

  // Re-read the folder's own listing rather than trusting a possibly-stale
  // "no existing file" assumption — same defensive-reread principle
  // pushProjectFilesToDrive.js already uses for the Project storage feature.
  const existing = (await listDriveFolderFiles(token, folderId)).find((f) => f.name === BACKUP_FILE_NAME);
  if (existing) {
    await updateDriveFileContent(token, existing.id, content, 'application/json');
  } else {
    await createDriveFile(token, { name: BACKUP_FILE_NAME, parentId: folderId, content, mimeType: 'application/json' });
  }

  const now = new Date();
  await prisma.deckGoogleConnection.update({
    where: { created_by_id: user.id },
    data: { backup_folder_id: folderId, last_backup_at: now },
  });

  const totalRows = Object.values(data).reduce((n, arr) => n + arr.length, 0);
  return { backedUpAt: now.toISOString(), totalRows };
}
