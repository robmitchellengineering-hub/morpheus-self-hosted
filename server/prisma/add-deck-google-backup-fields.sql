-- Drive backup (backupDeckToDrive.js / restoreDeckFromDrive.js) needs
-- somewhere to remember the backup folder + last-run time. Run on prod
-- Supabase via the SQL editor ("Run without RLS", as with every other
-- Morpheus table — Prisma direct connection, not PostgREST).

ALTER TABLE deck_google_connections ADD COLUMN IF NOT EXISTS backup_folder_id text;
ALTER TABLE deck_google_connections ADD COLUMN IF NOT EXISTS last_backup_at timestamp(3);
