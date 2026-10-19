-- Command Deck (Valiant Music) V1 — internal codename "Deck" throughout,
-- deliberately distinct from self-dev's own "Command Deck 4.0" roadmap/tier
-- system already used in this codebase. See schema.prisma's comment above
-- these models for the full rationale.
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table — Prisma direct connection, not PostgREST).

CREATE TABLE IF NOT EXISTS deck_dump_items (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text          text NOT NULL,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_dump_items_created_by_id_idx ON deck_dump_items (created_by_id);

CREATE TABLE IF NOT EXISTS deck_people (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  phone         text,
  color         text NOT NULL,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_people_created_by_id_idx ON deck_people (created_by_id);

CREATE TABLE IF NOT EXISTS deck_tasks (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            text NOT NULL,
  owner_person_id text,
  energy          text NOT NULL DEFAULT 'any',
  done            boolean NOT NULL DEFAULT false,
  created_date    timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date    timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_tasks_created_by_id_idx ON deck_tasks (created_by_id);

CREATE TABLE IF NOT EXISTS deck_consignment_items (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item          text NOT NULL,
  consignor     text NOT NULL,
  phone         text,
  price         double precision NOT NULL DEFAULT 0,
  date_in       timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sold          boolean NOT NULL DEFAULT false,
  photo_url     text,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_consignment_items_created_by_id_idx ON deck_consignment_items (created_by_id);

CREATE TABLE IF NOT EXISTS deck_repair_jobs (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer      text NOT NULL,
  phone         text,
  item          text NOT NULL,
  notes         text,
  stage         text NOT NULL DEFAULT 'waiting',
  photo_url     text,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_repair_jobs_created_by_id_idx ON deck_repair_jobs (created_by_id);

CREATE TABLE IF NOT EXISTS deck_repair_files (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  repair_job_id text NOT NULL REFERENCES deck_repair_jobs(id) ON DELETE CASCADE,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  file_url      text NOT NULL,
  is_image      boolean NOT NULL DEFAULT false,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_repair_files_repair_job_id_idx ON deck_repair_files (repair_job_id);

CREATE TABLE IF NOT EXISTS deck_murbah_opportunities (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  note          text,
  stage         text NOT NULL DEFAULT 'idea',
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_murbah_opportunities_created_by_id_idx ON deck_murbah_opportunities (created_by_id);

CREATE TABLE IF NOT EXISTS deck_inbox_items (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel       text NOT NULL,
  from_name     text NOT NULL,
  message       text NOT NULL,
  stage         text NOT NULL DEFAULT 'new',
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_inbox_items_created_by_id_idx ON deck_inbox_items (created_by_id);

CREATE TABLE IF NOT EXISTS deck_strategy_notes (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text          text NOT NULL,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_strategy_notes_created_by_id_idx ON deck_strategy_notes (created_by_id);

CREATE TABLE IF NOT EXISTS deck_knowledge_notes (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text          text NOT NULL,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_knowledge_notes_created_by_id_idx ON deck_knowledge_notes (created_by_id);

CREATE TABLE IF NOT EXISTS deck_life_streams (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stream_key    text NOT NULL,
  status        text NOT NULL DEFAULT 'needs_work',
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS deck_life_streams_created_by_id_stream_key_key ON deck_life_streams (created_by_id, stream_key);

CREATE TABLE IF NOT EXISTS deck_life_stream_notes (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  life_stream_id text NOT NULL REFERENCES deck_life_streams(id) ON DELETE CASCADE,
  created_by_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text           text NOT NULL,
  created_date   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_life_stream_notes_life_stream_id_idx ON deck_life_stream_notes (life_stream_id);

CREATE TABLE IF NOT EXISTS deck_energy_log_entries (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          timestamp(3) NOT NULL,
  level         text NOT NULL,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS deck_energy_log_entries_created_by_id_date_key ON deck_energy_log_entries (created_by_id, date);

CREATE TABLE IF NOT EXISTS deck_focus_entries (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          timestamp(3) NOT NULL,
  text          text NOT NULL,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS deck_focus_entries_created_by_id_date_key ON deck_focus_entries (created_by_id, date);
