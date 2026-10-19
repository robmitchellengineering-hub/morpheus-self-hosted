-- User-Choice Cloud Storage (Feature Backlog #12), Phase 1 — a project's
-- files can optionally mirror to the owner's own Google Drive instead of
-- staying Postgres-only. See schema.prisma's GoogleDriveConnection/
-- Project.storage_mode/ProjectFile.drive_file_id comments, and
-- server/src/lib/googleDrive.js for the full design.
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table — Prisma direct connection, not PostgREST).

CREATE TABLE IF NOT EXISTS google_drive_connections (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  drive_email   text NOT NULL,
  access_token  text NOT NULL,
  scope         text,
  refresh_token text NOT NULL,
  expires_at    timestamp(3),
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS storage_mode text NOT NULL DEFAULT 'postgres';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS drive_folder_id text;

ALTER TABLE project_files ADD COLUMN IF NOT EXISTS drive_file_id text;
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS drive_modified_time timestamp(3);
