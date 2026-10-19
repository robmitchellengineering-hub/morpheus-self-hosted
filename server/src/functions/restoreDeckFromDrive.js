// Restores every Deck* entity from the most recent Drive backup
// (backupDeckToDrive.js) — a clear "wipe and replace" of the account's own
// current Deck data, not a merge. Gated behind body.confirm === true so a
// stray call can't silently nuke live data; the actual confirm step lives
// in the Settings UI, not here.
//
// Original row ids are preserved (not regenerated) so the real FK
// relationships already in the backup — DeckRepairFile.repair_job_id,
// DeckLifeStreamNote.life_stream_id — come back intact automatically,
// rather than needing an old-id -> new-id remap. Safe because every id in a
// user's own backup only ever gets restored back into that same user's own
// (freshly emptied) rows — there is no cross-user restore path.
import { prisma } from '../db.js';
import { getDeckGoogleToken } from '../lib/deckGoogle.js';
import { listDriveFolderFiles, getDriveFileContent } from '../lib/googleDrive.js';

const BACKUP_FILE_NAME = 'command-deck-backup.json';

function asDate(v) {
  return v == null ? null : new Date(v);
}

// Strips nothing except re-stamping created_by_id to the current user
// (should already match, but never trust restored data over the real
// caller) and coercing known DateTime fields back from their JSON strings.
function prepRows(rows, userId, dateFields = []) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const row = { ...r, created_by_id: userId };
    for (const f of dateFields) if (f in row) row[f] = asDate(row[f]);
    return row;
  });
}

export default async function handler({ user, body }) {
  if (body?.confirm !== true) {
    throw Object.assign(new Error('Restore replaces all current Command Deck data — this call requires confirm: true.'), { status: 400 });
  }

  const { token } = await getDeckGoogleToken(user.id);
  const connection = await prisma.deckGoogleConnection.findUnique({ where: { created_by_id: user.id } });
  if (!connection?.backup_folder_id) {
    throw Object.assign(new Error('No backup found yet — run Backup first.'), { status: 400 });
  }

  const files = await listDriveFolderFiles(token, connection.backup_folder_id);
  const backupFile = files.find((f) => f.name === BACKUP_FILE_NAME);
  if (!backupFile) {
    throw Object.assign(new Error('No backup file found in the Drive folder — run Backup first.'), { status: 400 });
  }

  const raw = await getDriveFileContent(token, backupFile.id);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('The Drive backup file is not valid JSON.'), { status: 500 });
  }
  const data = parsed?.data;
  if (!data || typeof data !== 'object') {
    throw Object.assign(new Error('The Drive backup file has an unexpected shape.'), { status: 500 });
  }

  const userId = user.id;
  const where = { created_by_id: userId };

  const people = prepRows(data.people, userId, ['created_date', 'updated_date']);
  const dump = prepRows(data.dump, userId, ['created_date']);
  const tasks = prepRows(data.tasks, userId, ['created_date', 'updated_date']);
  const consignment = prepRows(data.consignment, userId, ['created_date', 'updated_date', 'date_in']);
  const repairs = prepRows(data.repairs, userId, ['created_date', 'updated_date']);
  const repairFiles = prepRows(data.repair_files, userId, ['created_date']);
  const murbah = prepRows(data.murbah, userId, ['created_date', 'updated_date']);
  const inbox = prepRows(data.inbox, userId, ['created_date', 'updated_date']);
  const strategy = prepRows(data.strategy, userId, ['created_date']);
  const knowledge = prepRows(data.knowledge, userId, ['created_date']);
  const lifeStreams = prepRows(data.life_streams, userId, ['created_date', 'updated_date']);
  const lifeStreamNotes = prepRows(data.life_stream_notes, userId, ['created_date']);
  const energyLog = prepRows(data.energy_log, userId, ['created_date', 'date']);
  const focusLog = prepRows(data.focus_log, userId, ['created_date', 'date']);

  await prisma.$transaction([
    // Children before parents (belt-and-braces alongside the schema's own
    // onDelete: Cascade), then everything else in any order.
    prisma.deckRepairFile.deleteMany({ where }),
    prisma.deckLifeStreamNote.deleteMany({ where }),
    prisma.deckDumpItem.deleteMany({ where }),
    prisma.deckPerson.deleteMany({ where }),
    prisma.deckTask.deleteMany({ where }),
    prisma.deckConsignmentItem.deleteMany({ where }),
    prisma.deckRepairJob.deleteMany({ where }),
    prisma.deckMurbahOpportunity.deleteMany({ where }),
    prisma.deckInboxItem.deleteMany({ where }),
    prisma.deckStrategyNote.deleteMany({ where }),
    prisma.deckKnowledgeNote.deleteMany({ where }),
    prisma.deckLifeStream.deleteMany({ where }),
    prisma.deckEnergyLogEntry.deleteMany({ where }),
    prisma.deckFocusEntry.deleteMany({ where }),

    // Parents before children on the way back in.
    prisma.deckPerson.createMany({ data: people }),
    prisma.deckDumpItem.createMany({ data: dump }),
    prisma.deckTask.createMany({ data: tasks }),
    prisma.deckConsignmentItem.createMany({ data: consignment }),
    prisma.deckRepairJob.createMany({ data: repairs }),
    prisma.deckRepairFile.createMany({ data: repairFiles }),
    prisma.deckMurbahOpportunity.createMany({ data: murbah }),
    prisma.deckInboxItem.createMany({ data: inbox }),
    prisma.deckStrategyNote.createMany({ data: strategy }),
    prisma.deckKnowledgeNote.createMany({ data: knowledge }),
    prisma.deckLifeStream.createMany({ data: lifeStreams }),
    prisma.deckLifeStreamNote.createMany({ data: lifeStreamNotes }),
    prisma.deckEnergyLogEntry.createMany({ data: energyLog }),
    prisma.deckFocusEntry.createMany({ data: focusLog }),
  ]);

  const totalRows = [people, dump, tasks, consignment, repairs, repairFiles, murbah, inbox, strategy, knowledge, lifeStreams, lifeStreamNotes, energyLog, focusLog]
    .reduce((n, arr) => n + arr.length, 0);

  return { restoredAt: new Date().toISOString(), totalRows, backedUpAt: parsed.exported_at || null };
}
