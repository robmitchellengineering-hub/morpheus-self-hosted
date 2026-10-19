-- One-time migration for the already-provisioned morpheus2 Supabase project:
-- the Media Library (2026-09-09 — see schema.prisma's ProjectAsset model and
-- src/components/matrix/MediaPanel.jsx).
--
-- Adds `projects.github_repo` (the "owner/repo" a project is connected to,
-- set by uploadToGithub.js / importFromGithub.js) and the `project_assets`
-- table (a project's content assets — Morpheus stores only the url + caption,
-- never the bytes).
--
-- Safe to run any time. Run once against morpheus2 Supabase (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-project-assets-table.sql`).
-- Until it runs, projects work normally and the MEDIA panel shows
-- "migration pending" (lib/projectAssets.js detects the missing table).

alter table projects add column if not exists github_repo text;

create table if not exists project_assets (
  id            text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  project_id    text not null references projects(id) on delete cascade,
  name          text not null,
  kind          text not null default 'image',
  source        text not null default 'url',
  url           text not null,
  preview_url   text,
  repo_path     text,
  alt           text,
  width         integer,
  height        integer,
  size          integer,
  created_date  timestamp(3) not null default now()
);

create index if not exists project_assets_project_date_idx
  on project_assets (project_id, created_date);
