-- One-time migration for the already-provisioned morpheus2 Supabase project,
-- adding the `project_documents` table for the "Project Files" tree — specs,
-- build plans, and other Morpheus-uploaded/generated reference docs, kept
-- separate from `project_files` (buildable source code; the only table ever
-- read by GitHub push, compile, or marketplace publish). See schema.prisma's
-- ProjectDocument model comment for the full rationale.
--
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-project-documents-table.sql`).
-- Skip this if you're initializing a brand-new database from scratch —
-- once this ships, add the same table to manual-supabase-init.sql too.

create table if not exists project_documents (
    id text primary key default gen_random_uuid()::text,
    created_by_id text not null references users(id) on delete cascade,
    project_id text not null references projects(id) on delete cascade,
    path text not null,
    content text,
    file_url text,
    mime_type text,
    size_bytes integer,
    source text not null default 'user',
    created_date timestamp not null default now(),
    updated_date timestamp not null default now(),
    unique (project_id, path)
  );
